/**
 * Gnani Timbre v3.0 streaming TTS client.
 *
 * Protocol (docs.gnani.ai/api/TTS/tts-websocket):
 *   WSS wss://api.vachana.ai/api/v1/tts
 *   header: X-API-Key-ID
 *   request: { text, voice, model, language, speed, audio_config }
 *   events: { type: "audio", data: { audio: base64, is_final } }
 *           { type: "complete" } / { type: "error", message }
 *
 * The previous implementation read `msg.audio`, which the API never sends, so it
 * only ever returned audio after hitting its timeout. This version reads the
 * documented `msg.data.audio` and resolves on `complete`.
 */

import WebSocket from 'ws';

export const TTS_URL = 'wss://api.vachana.ai/api/v1/tts';
export const TTS_REST_URL = 'https://api.vachana.ai/api/v1/tts/inference';

export class GnaniTTS {
  constructor(apiKey, { url = TTS_URL, restUrl = TTS_REST_URL, timeoutMs = 15000 } = {}) {
    this.apiKey = apiKey;
    this.url = url;
    this.restUrl = restUrl;
    this.timeoutMs = timeoutMs;
  }

  /**
   * @returns {Promise<Array<{audio:string, is_final:boolean, index?:number}>>}
   *          base64 audio chunks in play order
   */
  async synthesize(text, options = {}) {
    if (!this.apiKey) return [];
    if (!text) return [];

    const {
      voice = 'Shivani',
      model = 'timbre-v3.0',
      language = 'hi-IN',
      speed = 1.0,
      sampleRate = 16000,
      container = 'wav',
      encoding = 'linear_pcm',
    } = options;

    return new Promise((resolve, reject) => {
      const chunks = [];
      let settled = false;
      let timer = null;

      const ws = new WebSocket(this.url, {
        headers: { 'x-api-key-id': this.apiKey, 'Content-Type': 'application/json' },
        perMessageDeflate: false,
      });

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        try { ws.close(); } catch { /* noop */ }
        if (err) reject(err);
        else resolve(chunks);
      };

      ws.on('open', () => {
        ws.send(JSON.stringify({
          text,
          voice,
          model,
          language,
          speed,
          audio_config: {
            sample_rate: sampleRate,
            num_channels: 1,
            sample_width: 2,
            encoding,
            container,
          },
        }));
      });

      ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }

        const audio = msg?.data?.audio;
        if (msg.type === 'audio' && audio) {
          chunks.push({
            audio,
            is_final: Boolean(msg.data.is_final),
            index: msg.data.chunk_index,
          });
          return;
        }

        if (msg.type === 'complete') {
          finish();
          return;
        }

        if (msg.type === 'error') {
          finish(new Error(`TTS error: ${msg.message || 'unknown'}`));
          return;
        }

        // Tolerate the older flat shape rather than silently dropping audio.
        const legacyAudio = msg.audio || msg.audio_data;
        if (legacyAudio) {
          chunks.push({ audio: legacyAudio, is_final: Boolean(msg.is_final) });
        }
      });

      ws.on('error', (err) => finish(err));
      ws.on('close', () => {
        if (settled) return;
        finish(chunks.length > 0 ? null : new Error('TTS connection closed without audio'));
      });

      timer = setTimeout(() => {
        finish(chunks.length > 0 ? null : new Error('TTS timeout'));
      }, this.timeoutMs);
      timer.unref?.();
    });
  }

  /** REST fallback (full file in one response). */
  async synthesizeREST(text, options = {}) {
    if (!this.apiKey) throw new Error('GNANI_API_KEY is not configured');
    const { voice = 'Shivani', model = 'timbre-v3.0', language = 'hi-IN', speed = 1.0 } = options;

    const response = await fetch(this.restUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key-id': this.apiKey,
      },
      body: JSON.stringify({ text, voice, model, language, speed }),
    });

    if (!response.ok) {
      throw new Error(`TTS REST error: ${response.status} ${response.statusText}`);
    }
    return response.json();
  }
}
