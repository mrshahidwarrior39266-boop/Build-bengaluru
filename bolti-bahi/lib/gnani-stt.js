/**
 * Gnani Prisma v3.0 realtime STT client.
 *
 * Protocol (docs.gnani.ai/api/STT/stt-websocket):
 *   WSS wss://api.vachana.ai/stt/v3/stream
 *   headers: x-api-key-id, language_code, model, format, x-sample-rate, keyterms
 *   audio: raw signed 16-bit LE mono PCM, exactly 1024-byte frames, real-time pace
 *   events: connected | speech_start | processing | transcript | error
 *   control: {"type":"commit"} closes the open utterance immediately
 *
 * The API key only ever lives in the upgrade request header; it is never logged.
 */

import WebSocket from 'ws';

export const STT_URL = 'wss://api.vachana.ai/stt/v3/stream';

export const SHOP_KEYTERMS = [
  'udhaar', 'udhar', 'udhaari', 'khata', 'khate', 'jama', 'baaki',
  'rupay', 'rupaye', 'hisaab', 'parso', 'kal', 'aaj', 'credit', 'payment',
];

function asciiJsonArray(values) {
  // HTTP headers are bytes; escape non-ASCII so Devanagari terms survive.
  return JSON.stringify(values).replace(
    /[\u007f-\uffff]/g,
    (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

export class GnaniSTT {
  constructor(apiKey, { url = STT_URL, connectTimeoutMs = 15000 } = {}) {
    this.apiKey = apiKey;
    this.url = url;
    this.connectTimeoutMs = connectTimeoutMs;
  }

  async connect(options = {}) {
    const {
      model = 'prisma-v3.0',
      languageCode = 'hi-IN',
      format = 'codemix',
      sampleRate = 16000,
      keyterms = [],
      topic,
      idleTimeoutSec,
    } = options;

    if (!this.apiKey) throw new Error('GNANI_API_KEY is not configured');

    // Streaming accepts exactly one locale: a list like "hi-IN,en-IN" is
    // rejected with "exactly one locale is required", and multi_lang_codes is
    // not accepted on this endpoint. Take the first code and let Prisma v3.0
    // follow the language actually spoken.
    const primaryLanguage = String(languageCode || '')
      .split(',')
      .map((code) => code.trim())
      .filter(Boolean)[0] || 'hi-IN';

    const headers = {
      'x-api-key-id': this.apiKey,
      model,
      language_code: primaryLanguage,
      format,
      'x-sample-rate': String(sampleRate),
    };

    const terms = [...SHOP_KEYTERMS, ...keyterms].slice(0, 200);
    if (terms.length > 0) headers.keyterms = asciiJsonArray(terms);
    if (topic) headers.topic = String(topic);
    if (idleTimeoutSec) headers['x-idle-timeout-sec'] = String(idleTimeoutSec);

    return new Promise((resolve, reject) => {
      let settled = false;
      const ws = new WebSocket(this.url, { headers, perMessageDeflate: false });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { ws.close(); } catch { /* noop */ }
        reject(new Error(`STT connection timeout after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      timer.unref?.();

      ws.on('open', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(ws);
      });

      ws.on('unexpected-response', (req, res) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(`STT handshake failed: HTTP ${res.statusCode}`));
      });

      ws.on('error', (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /** Ask the server to close the open utterance instead of waiting for silence. */
  static commit(ws) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'commit' }));
    }
  }
}
