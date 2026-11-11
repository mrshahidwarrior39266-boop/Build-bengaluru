import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { createServer as createSecureServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomUUID } from 'crypto';
import { LedgerDB, localYmd } from './lib/ledger-db.js';
import { GnaniSTT } from './lib/gnani-stt.js';
import { GnaniTTS } from './lib/gnani-tts.js';
import { KhataAgent } from './lib/agent.js';
import { PcmFramer } from './lib/pcm-framer.js';
import { KeyStore } from './lib/key-store.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Optional HTTPS, mainly for phone testing: browsers only expose the microphone
// on a secure origin, and a LAN IP over plain HTTP is not one.
const TLS_CERT = process.env.TLS_CERT || join(__dirname, 'certs', 'dev-cert.pem');
const TLS_KEY = process.env.TLS_KEY || join(__dirname, 'certs', 'dev-key.pem');
const USE_TLS = process.env.HTTPS === '1' && existsSync(TLS_CERT) && existsSync(TLS_KEY);

const server = USE_TLS
  ? createSecureServer({ cert: readFileSync(TLS_CERT), key: readFileSync(TLS_KEY) }, app)
  : createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.KHATA_DB || join(__dirname, 'bolti-bahi.db');

// A key entered in the app is stored beside the ledger with mode 0600.
// An environment key still wins, so deployments can stay secret-managed.
const keyStore = new KeyStore({ file: join(dirname(DB_PATH), '.gnani-key') });
let GNANI_API_KEY = keyStore.get();
const RETENTION_MINUTES = Number(process.env.TRANSCRIPT_RETENTION_MINUTES || 120);
const ALLOW_RESET = process.env.ENABLE_RESET === '1' || process.env.NODE_ENV === 'test';

const ledger = new LedgerDB(DB_PATH);
const apiAgent = new KhataAgent({ ledger });

app.use(express.static(join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // The service worker and manifest must never be served from a stale cache.
    if (filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));
app.use(express.json({ limit: '2mb' }));

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    stt: Boolean(GNANI_API_KEY),
    tts: Boolean(GNANI_API_KEY),
    llm: Boolean(process.env.LLM_API_KEY),
    node: process.version,
    ledger: 'local-sqlite',
    transcripts: 'encrypted-at-rest',
    retentionMinutes: RETENTION_MINUTES,
  });
});

app.get('/api/ledger', (req, res) => {
  try {
    res.json({ success: true, entries: ledger.getAllEntries() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ledger/summary', (req, res) => {
  try {
    res.json({ success: true, summary: ledger.getCustomerSummary() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ledger/customer/:name', (req, res) => {
  try {
    const entries = ledger.getCustomerEntries(req.params.name);
    const balance = ledger.getCustomerBalance(req.params.name);
    res.json({ success: true, entries, balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Full snapshot used by the browser UI.
app.get('/api/state', (req, res) => {
  try {
    res.json({ success: true, ...ledger.getUiState() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// In-app settings: Gnani API key
// ---------------------------------------------------------------------------

function isSameOrigin(req) {
  const origin = req.get('origin');
  // Native shells and curl omit Origin; browsers always send it for POST.
  if (!origin) return true;
  try {
    return new URL(origin).host === req.get('host');
  } catch {
    return false;
  }
}

app.get('/api/settings', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    configured: Boolean(GNANI_API_KEY),
    source: keyStore.source(),
    stt: Boolean(GNANI_API_KEY),
    tts: Boolean(GNANI_API_KEY),
  });
});

app.post('/api/settings/gnani-key', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  if (keyStore.source() === 'environment') {
    return res.status(409).json({
      success: false,
      error: 'Key server environment se aa rahi hai. Wahan badalni hogi.',
    });
  }

  try {
    keyStore.set(req.body?.key);
    GNANI_API_KEY = keyStore.get();
    console.log('[Settings] Gnani key saved from the app (value not logged)');
    return res.json({
      success: true,
      configured: Boolean(GNANI_API_KEY),
      source: keyStore.source(),
      stt: Boolean(GNANI_API_KEY),
      tts: Boolean(GNANI_API_KEY),
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/settings/gnani-key', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  if (keyStore.source() === 'environment') {
    return res.status(409).json({
      success: false,
      error: 'Key server environment se aa rahi hai. Wahan hataani hogi.',
    });
  }
  keyStore.clear();
  GNANI_API_KEY = keyStore.get();
  console.log('[Settings] Gnani key removed from the app');
  return res.json({ success: true, configured: Boolean(GNANI_API_KEY), source: keyStore.source() });
});

// Text turn without a WebSocket (curl, judge script, accessibility fallback).
app.post('/api/text', (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'text is required' });
  const result = apiAgent.handle(text);
  return res.json({ success: true, ...result, state: ledger.getUiState() });
});

/**
 * Manual entry from the UI. Voice is the hero path, but a shopkeeper must be
 * able to correct or record something by hand, and this is the only way to add
 * an entry on a phone without a working microphone.
 */
app.post('/api/entries', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }

  const customerName = String(req.body?.customerName || '').trim().replace(/\s+/g, ' ');
  const amount = Number(req.body?.amount);
  const type = req.body?.type === 'payment' ? 'payment' : (req.body?.type === 'credit' ? 'credit' : null);
  const date = req.body?.date ? String(req.body.date) : undefined;
  const note = String(req.body?.note || '').trim().slice(0, 200);

  if (customerName.length < 2) {
    return res.status(400).json({ success: false, error: 'Grahak ka naam likhein.' });
  }
  if (customerName.length > 60) {
    return res.status(400).json({ success: false, error: 'Naam 60 akshar se chhota rakhein.' });
  }
  if (!/[\p{L}]/u.test(customerName)) {
    return res.status(400).json({ success: false, error: 'Naam mein kam se kam ek akshar hona chahiye.' });
  }
  if (!type) {
    return res.status(400).json({ success: false, error: 'Udhaar ya Jama chunein.' });
  }
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) {
    return res.status(400).json({ success: false, error: 'Rashi 0 se badi honi chahiye.' });
  }

  try {
    const entry = ledger.addEntry({ customerName, amount, type, date, note: note || null });
    const balance = ledger.getCustomerBalance(entry.customerName).balance;
    return res.json({ success: true, entry, balance, state: ledger.getUiState() });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/entries/:id', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  const removed = ledger.deleteEntryById(req.params.id);
  if (!removed) return res.status(404).json({ success: false, error: 'Entry nahi mili.' });
  return res.json({ success: true, removed, state: ledger.getUiState() });
});

app.delete('/api/customers/:id', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  try {
    const removed = ledger.deleteCustomerById(req.params.id);
    if (!removed.customers) return res.status(404).json({ success: false, error: 'Grahak nahi mila.' });
    return res.json({ success: true, removed, state: ledger.getUiState() });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/customers/:id', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  const updated = ledger.updateCustomerPhone(req.params.id, req.body?.phone);
  if (!updated) return res.status(404).json({ success: false, error: 'Grahak nahi mila.' });
  return res.json({ success: true, state: ledger.getUiState() });
});

app.get('/api/reports', (req, res) => {
  try {
    const range = String(req.query.range || 'today');
    const today = localYmd();
    const startOfMonth = `${today.slice(0, 7)}-01`;
    const weekAgo = localYmd(new Date(Date.now() - 6 * 24 * 60 * 60 * 1000));
    const from = range === 'all' ? '0000-01-01'
      : range === 'month' ? startOfMonth
        : range === 'week' ? weekAgo
          : today;
    res.json({ success: true, range, ...ledger.getReport(from, today) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/activity', (req, res) => {
  try {
    res.json({ success: true, entries: ledger.getActivity(Number(req.query.limit) || 25) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Data hygiene: the shopkeeper owns the data and must be able to clear it,
// including any test entries typed by mistake.
app.delete('/api/data', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  if (req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ success: false, error: 'confirm: DELETE chahiye.' });
  }
  ledger.resetAll();
  console.log('[Data] ledger cleared from the app');
  return res.json({ success: true, state: ledger.getUiState() });
});

app.post('/api/reminders/opt-in', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const optedIn = Boolean(req.body?.optIn);
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });
  const ok = ledger.setReminderOptIn(name, optedIn);
  return res.json({ success: ok, name, optIn: optedIn });
});

app.get('/api/reminders/preview/:name', (req, res) => {
  const agent = new KhataAgent({ ledger });
  const result = agent.handle(`${req.params.name} ko reminder bhejo`);
  res.json({ success: true, spoken: result.spoken, events: result.events });
});

app.post('/api/transcripts/purge', (req, res) => {
  const removed = ledger.purgeTranscripts();
  res.json({ success: true, purged: removed });
});

app.post('/api/reset', (req, res) => {
  if (!ALLOW_RESET) return res.status(403).json({ success: false, error: 'reset disabled' });
  ledger.resetAll();
  return res.json({ success: true });
});

// ---------------------------------------------------------------------------
// WebSocket voice sessions
// ---------------------------------------------------------------------------

function send(ws, type, payload = {}) {
  if (ws.readyState === WebSocket.OPEN) {
    // Envelope type wins: event payloads carry their own `type` field.
    ws.send(JSON.stringify({ ...payload, type }));
  }
}

function sendState(ws) {
  send(ws, 'ledger_summary', ledger.getUiState({ today: localYmd() }));
}

wss.on('connection', (clientWs) => {
  const sessionId = randomUUID();
  const agent = new KhataAgent({ ledger });
  let sttSocket = null;
  let sttCloseTimer = null;

  // Prisma needs 1024-byte frames at a real-time pace, whatever the browser sends.
  const framer = new PcmFramer({
    send: (frame) => {
      if (sttSocket && sttSocket.readyState === WebSocket.OPEN) sttSocket.send(frame);
    },
    onDrop: (bytes) => console.warn(`[Session ${sessionId}] audio backlog dropped ${bytes}B`),
  });

  console.log(`[Session ${sessionId}] connected`);

  // Responsible-AI rule: identify as an AI in the very first turn, in the
  // shopkeeper's language (Hindi/Hinglish), both on screen and spoken.
  send(clientWs, 'ai_disclosure', {
    text: agent.disclosureText,
    isFirstTurn: true,
    language: 'hi-IN',
    // Tells the client whether Timbre will speak this line, so it does not
    // also speak it through the browser voice.
    serverTts: Boolean(GNANI_API_KEY),
  });
  sendState(clientWs);
  speak(clientWs, agent.disclosureText, sessionId);

  function handleText(text) {
    if (!text || typeof text !== 'string') return;
    send(clientWs, 'transcript', { text, is_final: true });

    const result = agent.handle(text);

    for (const event of result.events) {
      if (event.type === 'entry') {
        const e = event.entry;
        send(clientWs, 'ledger_update', {
          action: event.corrected
            ? 'entry_corrected'
            : (e.type === 'credit' ? 'credit_added' : 'payment_added'),
          transaction: {
            customer: e.customerName,
            type: e.type,
            amount: e.amount,
            date: e.date,
            note: e.note || '',
            balance: event.balance,
            corrected_from: e.corrected_from,
          },
          entry: e,
          balance: event.balance,
        });
      } else if (event.type === 'clarification') {
        send(clientWs, 'clarification_needed', { ...event, serverTts: Boolean(GNANI_API_KEY) });
      } else if (event.type === 'query') {
        send(clientWs, 'query_response', event);
      } else if (event.type === 'reminder') {
        send(clientWs, 'reminder', event);
      }
    }

    send(clientWs, 'response_text', {
      text: result.spoken,
      intent: result.intent,
      latencyMs: result.latencyMs,
      useClientTts: !GNANI_API_KEY,
    });

    speak(clientWs, result.spoken, sessionId);
    sendState(clientWs);
  }

  clientWs.on('message', async (data, isBinary) => {
    try {
      if (isBinary) {
        if (sttSocket && sttSocket.readyState === WebSocket.OPEN) framer.push(data);
        return;
      }

      const message = JSON.parse(data.toString());

      switch (message.type) {
        case 'audio_start':
        case 'start_recording':
          await startStt();
          break;

        case 'audio_end':
        case 'stop_recording':
          stopStt();
          break;

        case 'text':
        case 'text_input':
        case 'transcript':
          handleText(message.text);
          break;

        case 'get_ledger':
          sendState(clientWs);
          break;

        case 'reset':
          if (ALLOW_RESET) {
            ledger.resetAll();
            agent.lastEntryId = null;
            agent.pending = null;
            sendState(clientWs);
          }
          break;

        default:
          send(clientWs, 'error', { message: `Unknown message type: ${message.type}` });
      }
    } catch (err) {
      console.error(`[Session ${sessionId}] message error:`, err.message);
      send(clientWs, 'error', { message: 'Message process nahi ho paya.' });
    }
  });

  async function startStt() {
    if (!GNANI_API_KEY) {
      send(clientWs, 'stt_unavailable', {
        message: 'Gnani STT key set nahi hai. Browser ki speech recognition istemal hogi.',
      });
      return;
    }
    if (sttSocket && sttSocket.readyState === WebSocket.OPEN) return;

    try {
      const stt = new GnaniSTT(GNANI_API_KEY);
      sttSocket = await stt.connect({
        model: 'prisma-v3.0',
        languageCode: 'hi-IN,en-IN',
        format: 'codemix',
        sampleRate: 16000,
      });
      framer.start();

      sttSocket.on('message', (raw) => {
        let payload;
        try {
          payload = JSON.parse(raw.toString());
        } catch (err) {
          console.error(`[Session ${sessionId}] STT parse error:`, err.message);
          return;
        }

        switch (payload.type) {
          case 'connected':
            console.log(`[Session ${sessionId}] STT connected`, payload.config || '');
            return;

          case 'processing':
            send(clientWs, 'stt_processing', { utteranceId: payload.utterance_id });
            return;

          case 'error':
            console.error(`[Session ${sessionId}] STT service error:`, payload.message);
            send(clientWs, 'stt_error', { message: 'Awaaz samajh nahi aayi, dobara boliye.' });
            return;

          case 'transcript': {
            const text = typeof payload.text === 'string' ? payload.text.trim() : '';
            if (!text) return;
            const isFinal = payload.is_final !== false;
            send(clientWs, 'transcript', {
              text,
              is_final: isFinal,
              detected_language: payload.detected_language_code,
              latency_ms: payload.latency,
            });
            if (isFinal) handleText(text);
            return;
          }

          default:
            // Older deployments send a flat { text } frame.
            if (payload.text) handleText(payload.text);
        }
      });

      sttSocket.on('error', (err) => {
        console.error(`[Session ${sessionId}] STT error:`, err.message);
        send(clientWs, 'stt_unavailable', { message: 'Voice service se sampark nahi hua.' });
      });

      sttSocket.on('close', () => {
        sttSocket = null;
      });
    } catch (err) {
      console.error(`[Session ${sessionId}] STT connect failed:`, err.message);
      send(clientWs, 'stt_unavailable', { message: 'Voice service se sampark nahi hua.' });
    }
  }

  function stopStt() {
    // Flush the pocket of audio the browser already captured, ask Prisma to
    // close the utterance, then give the final transcript a moment to arrive.
    framer.stop();
    if (sttSocket && sttSocket.readyState === WebSocket.OPEN) {
      framer.flush();
      GnaniSTT.commit(sttSocket);
      const socket = sttSocket;
      sttSocket = null;
      if (sttCloseTimer) clearTimeout(sttCloseTimer);
      sttCloseTimer = setTimeout(() => {
        sttCloseTimer = null;
        try { socket.close(); } catch { /* noop */ }
      }, 1200);
      sttCloseTimer.unref?.();
      return;
    }
    sttSocket = null;
  }

  clientWs.on('close', () => {
    console.log(`[Session ${sessionId}] closed`);
    stopStt();
  });
});

async function speak(ws, text, sessionId) {
  if (!GNANI_API_KEY || !text) return;
  try {
    const tts = new GnaniTTS(GNANI_API_KEY);
    const chunks = await tts.synthesize(text, {
      voice: 'Shivani',
      model: 'timbre-v3.0',
      language: 'hi-IN',
      speed: 1.0,
      sampleRate: 16000,
      // Headerless PCM: the browser wraps it once for AudioContext playback, so
      // a chunk boundary can never split a WAV header.
      container: 'raw',
    });
    if (chunks.length === 0) return;

    const pcm = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.audio, 'base64')));
    send(ws, 'audio_chunk', {
      audio: pcm.toString('base64'),
      format: 'pcm16',
      sampleRate: 16000,
      is_final: true,
    });
  } catch (err) {
    console.error(`[Session ${sessionId}] TTS error:`, err.message);
  }
}

// Transcript retention: spoken text is deleted after the judging window.
if (RETENTION_MINUTES > 0) {
  const timer = setInterval(() => {
    const purged = ledger.purgeTranscripts({ olderThanMinutes: RETENTION_MINUTES });
    if (purged > 0) console.log(`[Retention] purged ${purged} transcripts`);
  }, 5 * 60 * 1000);
  timer.unref();
}

server.listen(PORT, '0.0.0.0', () => {
  const scheme = USE_TLS ? 'https' : 'http';
  console.log(`\n🎙️  Bolti Bahi running at ${scheme}://localhost:${PORT}`);
  console.log(`📡 WebSocket: ${USE_TLS ? 'wss' : 'ws'}://localhost:${PORT}/ws`);
  if (process.env.HTTPS === '1' && !USE_TLS) {
    console.log('⚠️  HTTPS=1 but no certificate found. Run: npm run cert');
  }
  if (!USE_TLS) {
    console.log('ℹ️  Plain HTTP: phone microphones need HTTPS (npm run cert, then HTTPS=1 npm start).');
  }
  console.log(`🔐 Ledger: ${DB_PATH} (transcripts encrypted, retention ${RETENTION_MINUTES}m)`);
  if (!GNANI_API_KEY) console.log('ℹ️  GNANI_API_KEY missing: browser speech fallback will be used.');
  console.log('');
});

export { app, server, ledger };
