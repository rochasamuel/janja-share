/**
 * Bridges the native per-application capture into a WebRTC audio track.
 *
 * Rust captures what one process plays and streams raw f32 frames over a
 * Tauri channel; this turns them back into a `MediaStreamTrack` that peer
 * connections can send like any other.
 */

export interface AppAudioResult {
  track: MediaStreamTrack;
  /** The app the sound is coming from, e.g. "Discord.exe". */
  process: string;
  pid: number;
  stop: () => Promise<void>;
}

export class AppAudioUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppAudioUnavailableError";
  }
}

/**
 * Starts per-application capture for the window behind `trackLabel`.
 *
 * Throws `AppAudioUnavailableError` when the platform cannot do it — an old
 * Windows build, a whole-screen capture, or a window whose process could not
 * be resolved. The caller falls back to system audio.
 */
export async function startAppAudio(trackLabel: string): Promise<AppAudioResult> {
  const { invoke, Channel } = await import("@tauri-apps/api/core").catch(() => {
    throw new AppAudioUnavailableError("per-app audio needs the desktop app");
  });

  const context = new AudioContext({ sampleRate: 48_000 });
  await context.audioWorklet.addModule("/app-audio-worklet.js");

  const node = new AudioWorkletNode(context, "app-audio", {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],
    processorOptions: { channels: 2 },
  });

  const destination = context.createMediaStreamDestination();
  node.connect(destination);

  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (payload) => {
    // Transferred, not copied: this runs ~100 times a second.
    const buffer = payload instanceof ArrayBuffer ? payload : new Uint8Array(payload).buffer;
    node.port.postMessage(buffer, [buffer]);
  };

  let started: { pid: number; process: string };
  try {
    started = await invoke<{ pid: number; process: string }>("start_app_audio", {
      label: trackLabel,
      channel,
    });
  } catch (error) {
    await context.close();
    throw new AppAudioUnavailableError(
      error instanceof Error ? error.message : String(error),
    );
  }

  const track = destination.stream.getAudioTracks()[0];
  if (!track) {
    await context.close();
    throw new AppAudioUnavailableError("could not build an audio track");
  }

  return {
    track,
    process: started.process,
    pid: started.pid,
    stop: async () => {
      try {
        await invoke("stop_app_audio");
      } catch {
        // Already stopped.
      }
      track.stop();
      node.disconnect();
      await context.close();
    },
  };
}

/** Names the process behind a shared window, for diagnostics. */
export async function describeWindow(
  trackLabel: string,
): Promise<{ pid: number; process: string; title: string } | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    return await invoke("describe_window", { label: trackLabel });
  } catch {
    return null;
  }
}
