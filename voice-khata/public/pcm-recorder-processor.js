/**
 * PCM Recorder AudioWorklet Processor
 * Captures microphone audio and converts Float32 to 16-bit PCM Int16
 * for streaming to Gnani Prisma STT via WebSocket.
 * 
 * Runs on a separate audio thread for glitch-free recording on Android.
 */
class PCMRecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.isRecording = false;
    this.bufferSize = 4096; // Accumulate ~256ms at 16kHz before sending
    this.buffer = new Int16Array(this.bufferSize);
    this.bufferIndex = 0;

    this.port.onmessage = (event) => {
      if (event.data.command === 'start') {
        this.isRecording = true;
        this.bufferIndex = 0;
      } else if (event.data.command === 'stop') {
        // Flush remaining buffer
        if (this.bufferIndex > 0) {
          const remaining = this.buffer.slice(0, this.bufferIndex);
          this.port.postMessage({
            type: 'audio',
            buffer: remaining.buffer
          }, [remaining.buffer]);
          this.buffer = new Int16Array(this.bufferSize);
          this.bufferIndex = 0;
        }
        this.isRecording = false;
        this.port.postMessage({ type: 'stopped' });
      }
    };
  }

  process(inputs, outputs, parameters) {
    if (!this.isRecording) return true;

    const input = inputs[0];
    if (!input || input.length === 0) return true;

    const channelData = input[0]; // Float32Array, mono
    if (!channelData) return true;

    // Convert Float32 (-1.0 to 1.0) to Int16 (-32768 to 32767)
    for (let i = 0; i < channelData.length; i++) {
      const sample = Math.max(-1, Math.min(1, channelData[i]));
      this.buffer[this.bufferIndex++] = sample < 0
        ? sample * 0x8000
        : sample * 0x7FFF;

      // When buffer is full, send it
      if (this.bufferIndex >= this.bufferSize) {
        this.port.postMessage({
          type: 'audio',
          buffer: this.buffer.buffer
        }, [this.buffer.buffer]);

        // Allocate new buffer
        this.buffer = new Int16Array(this.bufferSize);
        this.bufferIndex = 0;
      }
    }

    return true;
  }
}

registerProcessor('pcm-recorder-processor', PCMRecorderProcessor);
