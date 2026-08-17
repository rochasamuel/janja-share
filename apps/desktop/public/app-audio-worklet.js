/**
 * Turns the PCM arriving from Rust into a real audio stream.
 *
 * A worklet rather than a ScriptProcessor because this runs on the audio
 * thread: a hitch on the main thread would otherwise be audible as a gap for
 * every viewer.
 *
 * The ring buffer absorbs the mismatch between how Windows delivers audio
 * (in bursts, whenever the app plays something) and how Web Audio consumes it
 * (in fixed 128-frame blocks, forever). Without it, every burst boundary
 * would click.
 */
class AppAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    const channels = options.processorOptions?.channels ?? 2;
    // Two seconds of slack. Large enough that a scheduling hiccup does not
    // empty it, small enough that latency stays under a frame of video.
    const capacity = sampleRate * 2 * channels;

    this.channels = channels;
    this.buffer = new Float32Array(capacity);
    this.capacity = capacity;
    this.readIndex = 0;
    this.writeIndex = 0;
    this.available = 0;
    /** Frames dropped because the consumer fell behind; reported for logging. */
    this.dropped = 0;

    this.port.onmessage = (event) => {
      if (event.data === "flush") {
        this.readIndex = 0;
        this.writeIndex = 0;
        this.available = 0;
        return;
      }
      this.write(new Float32Array(event.data));
    };
  }

  write(samples) {
    const overflow = this.available + samples.length - this.capacity;
    if (overflow > 0) {
      // Drop the oldest audio rather than the newest: staying current matters
      // more than completeness for a live stream.
      this.readIndex = (this.readIndex + overflow) % this.capacity;
      this.available -= overflow;
      this.dropped += overflow;
    }

    for (let i = 0; i < samples.length; i += 1) {
      this.buffer[this.writeIndex] = samples[i];
      this.writeIndex = (this.writeIndex + 1) % this.capacity;
    }
    this.available += samples.length;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;

    const frames = output[0].length;
    const channels = Math.min(this.channels, output.length);

    for (let frame = 0; frame < frames; frame += 1) {
      if (this.available >= this.channels) {
        for (let channel = 0; channel < this.channels; channel += 1) {
          const sample = this.buffer[this.readIndex];
          this.readIndex = (this.readIndex + 1) % this.capacity;
          if (channel < channels) output[channel][frame] = sample;
        }
        this.available -= this.channels;
      } else {
        // Underrun: emit silence rather than repeating the last block, which
        // would buzz.
        for (let channel = 0; channel < channels; channel += 1) {
          output[channel][frame] = 0;
        }
      }
    }

    return true;
  }
}

registerProcessor("app-audio", AppAudioProcessor);
