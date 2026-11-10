/**
 * PCM framer for Gnani Prisma streaming.
 *
 * Prisma requires raw 16-bit mono PCM in frames of exactly 1024 bytes
 * (512 samples, 32 ms at 16 kHz), sent at real-time cadence. Browsers hand us
 * arbitrary chunk sizes, so the server re-frames and paces them here.
 *
 * Frames are dropped from the front if the speaker's browser outruns the pace;
 * keeping stale audio would desynchronise VAD more than dropping it.
 */

export const STT_FRAME_BYTES = 1024;
export const STT_FRAME_MS = 32;

export class PcmFramer {
  constructor({
    send,
    frameBytes = STT_FRAME_BYTES,
    intervalMs = STT_FRAME_MS,
    maxQueueBytes = 64000,
    onDrop = null,
  } = {}) {
    if (typeof send !== 'function') throw new Error('PcmFramer needs a send function');
    this.send = send;
    this.frameBytes = frameBytes;
    this.intervalMs = intervalMs;
    this.maxQueueBytes = maxQueueBytes;
    this.onDrop = onDrop;

    this.queue = [];
    this.queuedBytes = 0;
    this.droppedBytes = 0;
    this.carry = Buffer.alloc(0);
    this.timer = null;
  }

  get bufferedBytes() {
    return this.queuedBytes + this.carry.length;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this._tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  push(chunk) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) return;

    const data = this.carry.length > 0 ? Buffer.concat([this.carry, buf]) : buf;
    let offset = 0;
    while (data.length - offset >= this.frameBytes) {
      const frame = data.subarray(offset, offset + this.frameBytes);
      this.queue.push(frame);
      this.queuedBytes += frame.length;
      offset += this.frameBytes;
    }
    this.carry = Buffer.from(data.subarray(offset));

    while (this.queuedBytes > this.maxQueueBytes && this.queue.length > 0) {
      const dropped = this.queue.shift();
      this.queuedBytes -= dropped.length;
      this.droppedBytes += dropped.length;
      if (this.onDrop) this.onDrop(dropped.length);
    }
  }

  _tick() {
    const frame = this.queue.shift();
    if (!frame) return;
    this.queuedBytes -= frame.length;
    this.send(frame);
  }

  /** Send every queued frame immediately (end of utterance). */
  drainNow() {
    while (this.queue.length > 0) {
      const frame = this.queue.shift();
      this.queuedBytes -= frame.length;
      this.send(frame);
    }
  }

  /** Pad the trailing partial frame to a legal size, then drain. */
  flush() {
    if (this.carry.length > 0) {
      const padded = Buffer.alloc(this.frameBytes);
      this.carry.copy(padded);
      this.queue.push(padded);
      this.queuedBytes += padded.length;
      this.carry = Buffer.alloc(0);
    }
    this.drainNow();
  }
}
