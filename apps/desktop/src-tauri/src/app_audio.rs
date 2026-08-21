//! Per-application audio capture.
//!
//! `getDisplayMedia` can only ever return a system-wide loopback mix. When
//! someone shares a game while talking on Discord, that mix carries the other
//! person's voice straight into the stream. Windows exposes a way out —
//! process loopback capture, via `ActivateAudioInterfaceAsync` on the virtual
//! `VAD\Process_Loopback` device — but only to native code.
//!
//! Requires Windows 10 build 20348 or newer. Older builds fail activation,
//! and the caller falls back to system audio.

#![cfg(target_os = "windows")]

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use windows::core::{implement, Interface, Ref, Result as WinResult, GUID};
use windows::Win32::Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0};
use windows::Win32::Media::Audio::{
    ActivateAudioInterfaceAsync, IActivateAudioInterfaceAsyncOperation,
    IActivateAudioInterfaceCompletionHandler, IActivateAudioInterfaceCompletionHandler_Impl,
    IAudioCaptureClient, IAudioClient, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
    AUDCLNT_STREAMFLAGS_EVENTCALLBACK, AUDCLNT_STREAMFLAGS_LOOPBACK,
    AUDIOCLIENT_ACTIVATION_PARAMS, AUDIOCLIENT_ACTIVATION_PARAMS_0,
    AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK, AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS,
    PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE, VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
    WAVEFORMATEX, WAVE_FORMAT_PCM,
};
use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_MULTITHREADED};
use windows::Win32::System::Com::StructuredStorage::PROPVARIANT;
use windows::Win32::System::Threading::{CreateEventW, SetEvent, WaitForSingleObject};

/// What the audio pipeline runs at. 48 kHz stereo matches what Web Audio uses
/// on the other end, so nothing has to be resampled in JavaScript.
pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;

/// 100 ms of buffer. Long enough to survive a scheduling hiccup, short enough
/// that audio does not drift audibly behind the picture.
const BUFFER_DURATION_100NS: i64 = 1_000_000;

/// How much audio to gather before handing it to the frontend: 40 ms.
///
/// Windows delivers loopback audio in 10 ms packets, and each delivery costs a
/// full trip through Tauri's channel — a script evaluation in the webview plus
/// a fetch back to Rust for the bytes, since a packet is larger than the
/// direct-execute threshold. A hundred of those a second is a steady tax on
/// the machine that is also running the game. Four packets per trip cuts it to
/// twenty-five, for a delay the viewer cannot perceive: audio is already well
/// ahead of a picture that has to be captured, encoded and jitter-buffered.
const BATCH_FRAMES: usize = SAMPLE_RATE as usize * 40 / 1000;

/// How long to wait for the next packet before sending what is already held.
///
/// A game that falls silent stops producing packets, and the last slice of
/// its sound must not sit here until it speaks again.
const FLUSH_TIMEOUT_MS: u32 = 50;

/// A `PROPVARIANT` holding a blob.
///
/// Hand-rolled because windows-rs models `PROPVARIANT` as an opaque type with
/// no way to construct the `VT_BLOB` case, and process loopback activation
/// takes its parameters exactly that way. Layout matches the C struct on x64:
/// four 16-bit fields, then the 16-byte union.
#[repr(C)]
struct BlobPropVariant {
    vt: u16,
    reserved1: u16,
    reserved2: u16,
    reserved3: u16,
    cb_size: u32,
    _padding: u32,
    blob_data: *mut u8,
}

const VT_BLOB: u16 = 65;

/// Defined here rather than imported: windows-rs keeps this one in the
/// Multimedia module, and pulling that whole surface in for a single integer
/// is not worth the compile time.
const WAVE_FORMAT_IEEE_FLOAT: u32 = 3;

/// Signals the async activation is done. `ActivateAudioInterfaceAsync` returns
/// immediately and calls back on another thread, so the capture thread has to
/// wait for this before it has an `IAudioClient`.
#[implement(IActivateAudioInterfaceCompletionHandler)]
struct ActivationHandler {
    event: HANDLE,
}

impl IActivateAudioInterfaceCompletionHandler_Impl for ActivationHandler_Impl {
    fn ActivateCompleted(
        &self,
        _operation: Ref<'_, IActivateAudioInterfaceAsyncOperation>,
    ) -> WinResult<()> {
        unsafe {
            let _ = SetEvent(self.event);
        }
        Ok(())
    }
}

pub struct CaptureHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl CaptureHandle {
    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl Drop for CaptureHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

/// Starts capturing everything `pid` and its children play.
///
/// `on_audio` receives interleaved stereo f32 frames and runs on the capture
/// thread, so it must not block: anything slow there shows up as a gap in the
/// audio the viewers hear.
pub fn start<F>(pid: u32, on_audio: F) -> Result<CaptureHandle, String>
where
    F: Fn(&[f32]) + Send + 'static,
{
    let stop = Arc::new(AtomicBool::new(false));
    let thread_stop = Arc::clone(&stop);

    // The thread reports whether it got as far as capturing, so activation
    // failures surface here rather than as silence.
    let startup: Arc<(Mutex<Option<Result<(), String>>>, std::sync::Condvar)> =
        Arc::new((Mutex::new(None), std::sync::Condvar::new()));
    let thread_startup = Arc::clone(&startup);

    let thread = std::thread::Builder::new()
        .name("app-audio-capture".into())
        .spawn(move || {
            let result = unsafe { capture_loop(pid, &thread_stop, &on_audio, &thread_startup) };
            if let Err(message) = result {
                report(&thread_startup, Err(message));
            }
        })
        .map_err(|e| format!("could not start the audio thread: {e}"))?;

    // Wait for activation before telling the caller it worked.
    let (lock, condvar) = &*startup;
    let mut state = lock.lock().map_err(|_| "audio thread panicked".to_string())?;
    let timeout = std::time::Duration::from_secs(5);
    let start = std::time::Instant::now();
    while state.is_none() {
        if start.elapsed() >= timeout {
            stop.store(true, Ordering::Relaxed);
            return Err("timed out activating process audio capture".into());
        }
        let (next, _) = condvar
            .wait_timeout(state, std::time::Duration::from_millis(100))
            .map_err(|_| "audio thread panicked".to_string())?;
        state = next;
    }

    match state.take() {
        Some(Ok(())) => Ok(CaptureHandle {
            stop,
            thread: Some(thread),
        }),
        Some(Err(message)) => Err(message),
        None => Err("audio capture did not start".into()),
    }
}

fn report(
    startup: &Arc<(Mutex<Option<Result<(), String>>>, std::sync::Condvar)>,
    outcome: Result<(), String>,
) {
    let (lock, condvar) = &**startup;
    if let Ok(mut slot) = lock.lock() {
        if slot.is_none() {
            *slot = Some(outcome);
            condvar.notify_all();
        }
    }
}

unsafe fn capture_loop<F>(
    pid: u32,
    stop: &Arc<AtomicBool>,
    on_audio: &F,
    startup: &Arc<(Mutex<Option<Result<(), String>>>, std::sync::Condvar)>,
) -> Result<(), String>
where
    F: Fn(&[f32]),
{
    let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    let result = capture_inner(pid, stop, on_audio, startup);
    CoUninitialize();
    result
}

unsafe fn capture_inner<F>(
    pid: u32,
    stop: &Arc<AtomicBool>,
    on_audio: &F,
    startup: &Arc<(Mutex<Option<Result<(), String>>>, std::sync::Condvar)>,
) -> Result<(), String>
where
    F: Fn(&[f32]),
{
    let activated = CreateEventW(None, false, false, None)
        .map_err(|e| format!("could not create the activation event: {e}"))?;

    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: pid,
                // Include rather than exclude: capturing only the shared app
                // is what keeps a voice call out of the stream. Excluding one
                // app would still let every other notification through.
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };

    let blob = BlobPropVariant {
        vt: VT_BLOB,
        reserved1: 0,
        reserved2: 0,
        reserved3: 0,
        cb_size: std::mem::size_of::<AUDIOCLIENT_ACTIVATION_PARAMS>() as u32,
        _padding: 0,
        blob_data: &mut params as *mut _ as *mut u8,
    };

    let handler: IActivateAudioInterfaceCompletionHandler =
        ActivationHandler { event: activated }.into();

    let operation = ActivateAudioInterfaceAsync(
        VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK,
        &IAudioClient::IID as *const GUID,
        Some(&blob as *const BlobPropVariant as *const PROPVARIANT),
        &handler,
    )
    .map_err(|e| format!("process audio capture is unavailable: {e}"))?;

    if WaitForSingleObject(activated, 3000) != WAIT_OBJECT_0 {
        let _ = CloseHandle(activated);
        return Err("timed out waiting for the audio device".into());
    }
    let _ = CloseHandle(activated);

    let mut activation_result = windows::core::HRESULT(0);
    let mut interface: Option<windows::core::IUnknown> = None;
    operation
        .GetActivateResult(&mut activation_result, &mut interface)
        .map_err(|e| format!("could not activate process audio: {e}"))?;
    activation_result
        .ok()
        .map_err(|e| format!("windows refused process audio capture: {e}"))?;

    let client: IAudioClient = interface
        .ok_or_else(|| "windows returned no audio client".to_string())?
        .cast()
        .map_err(|e| format!("unexpected audio interface: {e}"))?;

    // The virtual loopback device has no mix format to query, so the format is
    // ours to state. Float first because it is what Web Audio wants; 16-bit
    // PCM is the format the Microsoft sample uses and is the safer fallback.
    let format = match initialize(&client, WAVE_FORMAT_IEEE_FLOAT as u16, 32) {
        Ok(()) => SampleFormat::Float32,
        Err(_) => {
            initialize(&client, WAVE_FORMAT_PCM as u16, 16)
                .map_err(|e| format!("could not start process audio: {e}"))?;
            SampleFormat::Int16
        }
    };

    let buffer_event = CreateEventW(None, false, false, None)
        .map_err(|e| format!("could not create the audio event: {e}"))?;
    client
        .SetEventHandle(buffer_event)
        .map_err(|e| format!("could not attach the audio event: {e}"))?;

    let capture: IAudioCaptureClient = client
        .GetService()
        .map_err(|e| format!("could not open the capture client: {e}"))?;

    client
        .Start()
        .map_err(|e| format!("could not start capturing: {e}"))?;

    report(startup, Ok(()));

    let batch_samples = BATCH_FRAMES * CHANNELS as usize;
    let mut pending: Vec<f32> = Vec::with_capacity(batch_samples * 2);

    while !stop.load(Ordering::Relaxed) {
        // A timeout rather than an infinite wait: a silent app produces no
        // events, and the loop still has to notice it was asked to stop — and
        // to send the tail of whatever it was holding.
        if WaitForSingleObject(buffer_event, FLUSH_TIMEOUT_MS) != WAIT_OBJECT_0 {
            if !pending.is_empty() {
                on_audio(&pending);
                pending.clear();
            }
            continue;
        }

        loop {
            let packet_frames = match capture.GetNextPacketSize() {
                Ok(frames) => frames,
                Err(_) => break,
            };
            if packet_frames == 0 {
                break;
            }

            let mut data: *mut u8 = std::ptr::null_mut();
            let mut frames = 0u32;
            let mut flags = 0u32;
            if capture
                .GetBuffer(&mut data, &mut frames, &mut flags, None, None)
                .is_err()
            {
                break;
            }

            let samples = frames as usize * CHANNELS as usize;

            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                // Windows may hand back a silent packet with no real buffer;
                // the stream still needs those samples or it drifts.
                pending.resize(pending.len() + samples, 0.0);
            } else {
                match format {
                    SampleFormat::Float32 => {
                        let src = std::slice::from_raw_parts(data as *const f32, samples);
                        pending.extend_from_slice(src);
                    }
                    SampleFormat::Int16 => {
                        let src = std::slice::from_raw_parts(data as *const i16, samples);
                        pending.extend(src.iter().map(|s| *s as f32 / 32768.0));
                    }
                }
            }

            // Copied out before the release: the buffer belongs to Windows
            // again the moment ReleaseBuffer returns.
            let _ = capture.ReleaseBuffer(frames);

            if pending.len() >= batch_samples {
                on_audio(&pending);
                pending.clear();
            }
        }
    }

    let _ = client.Stop();
    let _ = CloseHandle(buffer_event);
    Ok(())
}

#[derive(Clone, Copy)]
enum SampleFormat {
    Float32,
    Int16,
}

unsafe fn initialize(client: &IAudioClient, tag: u16, bits: u16) -> WinResult<()> {
    let block_align = CHANNELS * bits / 8;
    let format = WAVEFORMATEX {
        wFormatTag: tag,
        nChannels: CHANNELS,
        nSamplesPerSec: SAMPLE_RATE,
        nAvgBytesPerSec: SAMPLE_RATE * block_align as u32,
        nBlockAlign: block_align,
        wBitsPerSample: bits,
        cbSize: 0,
    };

    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        BUFFER_DURATION_100NS,
        0,
        &format,
        None,
    )
}
