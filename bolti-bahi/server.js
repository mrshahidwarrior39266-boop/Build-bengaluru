import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { createServer as createSecureServer } from 'https';
import { readFileSync, existsSync } from 'fs';
import { WebSocketServer, WebSocket } from 'ws';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { randomBytes, randomUUID } from 'crypto';
import { localYmd } from './lib/shop-date.js';
import { GnaniSTT } from './lib/gnani-stt.js';
import { GnaniTTS } from './lib/gnani-tts.js';
import { KhataAgent } from './lib/agent.js';
import { PcmFramer } from './lib/pcm-framer.js';
import { KeyStore } from './lib/key-store.js';
import { LlmBrain } from './lib/llm-brain.js';
import { StoreRegistry } from './lib/store-registry.js';
import { GoogleAuth } from './lib/google-auth.js';

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

// In-app Gnani & LLM keys stored beside the ledger with mode 0600.
// Environment keys still win, so deployments can stay secret-managed.
const keyStore = new KeyStore({ file: process.env.GNANI_KEY_FILE || join(dirname(DB_PATH), '.gnani-key') });
let GNANI_API_KEY = keyStore.get();
const llmKeyStore = new KeyStore({
  file: join(dirname(DB_PATH), '.llm-key'),
  envKey: process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENROUTER_API_KEY || process.env.XAI_API_KEY || process.env.LLM_API_KEY || '',
});
let ACTIVE_LLM_KEY = llmKeyStore.get();
const RETENTION_MINUTES = Number(process.env.TRANSCRIPT_RETENTION_MINUTES || 120);
const ALLOW_RESET = process.env.ENABLE_RESET === '1' || process.env.NODE_ENV === 'test';

// One ledger file per shop. The pre-existing single-user ledger is the
// "default" store, used when Google sign-in is not configured.
const registry = new StoreRegistry({
  metaPath: process.env.STORE_DB || join(dirname(DB_PATH), 'stores.db'),
  dataDir: process.env.STORE_DATA_DIR || join(dirname(DB_PATH), 'stores'),
  defaultDbPath: DB_PATH,
  defaultStoreName: process.env.STORE_NAME || 'Meri Dukaan',
});
const googleAuth = new GoogleAuth();
const ledger = registry.ledgerFor('default');

// Optional Grok/Groq/Gemini fallback for phrasing the local parser cannot read. Off unless a
// key is configured; the server never sends the key to the browser.
let llm = new LlmBrain({ apiKey: ACTIVE_LLM_KEY || undefined });
const agentFor = (storeLedger) => new KhataAgent({ ledger: storeLedger, brain: llm });

app.use(express.json({ limit: '2mb' }));
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// Store accounts: Google sign-in, sessions, per-store ledgers
// ---------------------------------------------------------------------------

const SESSION_COOKIE = 'bb_session';
const OAUTH_STATE_COOKIE = 'bb_oauth_state';
const LOGIN_PAGE = join(__dirname, 'public', 'login.html');

function readCookie(req, name) {
  const header = req?.headers?.cookie;
  if (!header) return '';
  for (const part of String(header).split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

function cookieHeader(name, value, { maxAgeMs = 0, secure = false } = {}) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeMs > 0) bits.push(`Max-Age=${Math.floor(maxAgeMs / 1000)}`);
  if (secure) bits.push('Secure');
  return bits.join('; ');
}

const isSecureRequest = (req) => Boolean(req.secure) || req.get('x-forwarded-proto') === 'https';
const redirectUriFor = (req) => process.env.GOOGLE_REDIRECT_URI
  || `${isSecureRequest(req) ? 'https' : 'http'}://${req.get('host')}/auth/google/callback`;

// Every request resolves to exactly one shop (and therefore one ledger).
app.use((req, res, next) => {
  const token = readCookie(req, SESSION_COOKIE);
  const session = token ? registry.getSession(token) : null;
  req.sessionToken = token || null;
  req.authed = Boolean(session);
  req.store = session || registry.getStore('default');
  req.ledger = registry.ledgerFor(req.store?.id || 'default');
  next();
});

// A signed-out browser gets a real login page, not the app shell with a modal
// flashed over it. API clients still get the JSON 401 from requireAuth below.
app.get(['/', '/index.html'], (req, res, next) => {
  if (googleAuth.enabled && !req.authed) {
    res.set('Cache-Control', 'no-store');
    return res.sendFile(LOGIN_PAGE);
  }
  return next();
});

app.get('/login', (req, res) => {
  if (googleAuth.enabled && req.authed) return res.redirect('/');
  res.set('Cache-Control', 'no-store');
  return res.sendFile(LOGIN_PAGE);
});

app.get('/api/session', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json({
    success: true,
    authRequired: googleAuth.enabled,
    authenticated: req.authed,
    loginUrl: googleAuth.enabled && !req.authed ? '/login' : null,
    // Never describe a shop to someone who is not signed into it.
    store: req.store && (req.authed || !googleAuth.enabled) ? {
      id: req.store.id,
      name: req.store.store_name || '',
      needsName: !req.store.store_name,
    } : null,
    owner: req.authed ? { email: req.store.email || '', name: req.store.owner_name || '' } : null,
  });
});

app.get('/auth/google', (req, res) => {
  if (!googleAuth.enabled) return res.redirect('/login?auth=disabled');
  const state = randomBytes(16).toString('hex');
  res.setHeader('Set-Cookie', cookieHeader(OAUTH_STATE_COOKIE, state, {
    maxAgeMs: 10 * 60 * 1000,
    secure: isSecureRequest(req),
  }));
  return res.redirect(googleAuth.authorizationUrl({ redirectUri: redirectUriFor(req), state }));
});

app.get('/auth/google/callback', async (req, res) => {
  if (!googleAuth.enabled) return res.redirect('/login?auth=disabled');
  const code = String(req.query.code || '');
  const state = String(req.query.state || '');
  const expected = readCookie(req, OAUTH_STATE_COOKIE);
  if (!code || !state || !expected || state !== expected) {
    console.warn('[Auth] state mismatch or missing code');
    return res.status(400).sendFile(LOGIN_PAGE);
  }

  try {
    const profile = await googleAuth.exchange({ code, redirectUri: redirectUriFor(req) });
    const store = registry.upsertGoogleStore(profile);
    const session = registry.createSession(store.id);
    res.setHeader('Set-Cookie', [
      cookieHeader(SESSION_COOKIE, session.token, { maxAgeMs: 30 * 24 * 60 * 60 * 1000, secure: isSecureRequest(req) }),
      cookieHeader(OAUTH_STATE_COOKIE, '', { maxAgeMs: 1, secure: isSecureRequest(req) }),
    ]);
    console.log('[Auth] signed in store', store.id);
    return res.redirect('/');
  } catch (err) {
    console.error('[Auth] Google sign-in failed:', err.message);
    return res.status(400).sendFile(LOGIN_PAGE);
  }
});

app.post('/auth/email', (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const name = String(req.body?.name || '').trim();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ success: false, error: 'Kripya sahi email address likhein.' });
  }
  try {
    const store = registry.upsertEmailStore({ email, name });
    const session = registry.createSession(store.id);
    res.setHeader('Set-Cookie', [
      cookieHeader(SESSION_COOKIE, session.token, { maxAgeMs: 30 * 24 * 60 * 60 * 1000, secure: isSecureRequest(req) }),
    ]);
    console.log('[Auth] signed in store via email:', store.id, email);
    return res.json({ success: true, redirect: '/' });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/auth/logout', (req, res) => {
  if (req.sessionToken) registry.destroySession(req.sessionToken);
  res.setHeader('Set-Cookie', cookieHeader(SESSION_COOKIE, '', {
    maxAgeMs: 1,
    secure: isSecureRequest(req),
  }));
  return res.json({ success: true });
});

app.use(express.static(join(__dirname, 'public'), {
  setHeaders(res, filePath) {
    // The service worker and manifest must never be served from a stale cache.
    if (filePath.endsWith('sw.js') || filePath.endsWith('.webmanifest')) {
      res.setHeader('Cache-Control', 'no-cache');
    }
  },
}));

// ---------------------------------------------------------------------------
// REST API
// ---------------------------------------------------------------------------

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    stt: Boolean(GNANI_API_KEY),
    tts: Boolean(GNANI_API_KEY),
    llm: llm.enabled,
    llmMode: llm.mode,
    llmProvider: llm.enabled ? llm.provider : null,
    llmModel: llm.enabled ? llm.model : null,
    googleAuth: googleAuth.enabled,
    node: process.version,
    ledger: 'local-sqlite',
    transcripts: 'encrypted-at-rest',
    retentionMinutes: RETENTION_MINUTES,
  });
});

// ---------------------------------------------------------------------------
// High-Fidelity Human-Like Neural TTS (/api/tts)
// Publicly accessible for UI and speech playback
// 1. Synthesizes via Gnani Timbre if GNANI_API_KEY is configured
// 2. Synthesizes via Google Neural Hindi voice if no key (crystal-clear human voice)
// ---------------------------------------------------------------------------
const ttsCache = new Map();

app.get('/api/tts', async (req, res) => {
  const text = String(req.query.text || '').trim();
  if (!text) return res.status(400).send('text is required');

  const clean = text
    .replace(/₹\s*(\d+)/g, '$1 rupaye ')
    .replace(/₹/g, 'rupaye ')
    .slice(0, 600);

  const cacheKey = `${GNANI_API_KEY ? 'gnani' : 'neural'}:${clean}`;
  if (ttsCache.has(cacheKey)) {
    const cached = ttsCache.get(cacheKey);
    res.set({
      'Content-Type': cached.contentType,
      'Content-Length': cached.buffer.length,
      'Cache-Control': 'public, max-age=86400',
    });
    return res.end(cached.buffer);
  }

  // 1. Gnani Timbre if API key is active
  if (GNANI_API_KEY) {
    try {
      const tts = new GnaniTTS(GNANI_API_KEY);
      const chunks = await tts.synthesize(clean, {
        voice: process.env.GNANI_TTS_VOICE || 'Shivani',
        model: 'timbre-v3.0',
        language: process.env.GNANI_TTS_LANGUAGE || 'hi-IN',
        speed: Number(process.env.GNANI_TTS_SPEED || 0.94),
        container: 'wav',
      });
      if (chunks.length > 0) {
        const audioBuf = Buffer.concat(chunks.map((c) => Buffer.from(c.audio, 'base64')));
        if (ttsCache.size > 200) ttsCache.clear();
        ttsCache.set(cacheKey, { buffer: audioBuf, contentType: 'audio/wav' });
        res.set({
          'Content-Type': 'audio/wav',
          'Content-Length': audioBuf.length,
          'Cache-Control': 'public, max-age=86400',
        });
        return res.end(audioBuf);
      }
    } catch (gnaniErr) {
      console.warn('[TTS] Gnani synthesis failed, using Neural Hindi TTS:', gnaniErr.message);
    }
  }

  // 2. High-fidelity Neural Hindi Voice
  try {
    const segments = clean.match(/[^.!?।\n]+[.!?।\n]?/g) || [clean];
    const buffers = [];

    for (const segment of segments) {
      const trimmed = segment.trim();
      if (!trimmed) continue;
      const url = `https://translate.google.com/translate_tts?ie=UTF-8&tl=hi&client=tw-ob&q=${encodeURIComponent(trimmed)}`;
      const resp = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Referer': 'https://translate.google.com/',
        },
      });
      if (resp.ok) {
        const ab = await resp.arrayBuffer();
        buffers.push(Buffer.from(ab));
      }
    }

    if (buffers.length > 0) {
      const fullBuffer = Buffer.concat(buffers);
      if (ttsCache.size > 200) ttsCache.clear();
      ttsCache.set(cacheKey, { buffer: fullBuffer, contentType: 'audio/mpeg' });
      res.set({
        'Content-Type': 'audio/mpeg',
        'Content-Length': fullBuffer.length,
        'Cache-Control': 'public, max-age=86400',
      });
      return res.end(fullBuffer);
    }
  } catch (err) {
    console.error('[TTS] Neural voice error:', err.message);
  }

  return res.status(502).json({ success: false, error: 'tts_failed' });
});

function requireAuth(req, res, next) {
  if (!googleAuth.enabled) return next();
  if (!req.authed) return res.status(401).json({ success: false, error: 'login_required' });
  return next();
}

app.use('/api', requireAuth);

// Store onboarding: the shop keeps its own name, shown in the app header.
app.post('/api/store', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  if (!req.store) {
    return res.status(401).json({ success: false, error: 'login_required' });
  }
  try {
    const store = registry.setStoreName(req.store.id, req.body?.name);
    return res.json({ success: true, store: { id: store.id, name: store.store_name } });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/ledger', (req, res) => {
  try {
    res.json({ success: true, entries: req.ledger.getAllEntries() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ledger/summary', (req, res) => {
  try {
    res.json({ success: true, summary: req.ledger.getCustomerSummary() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/ledger/customer/:name', (req, res) => {
  try {
    const entries = req.ledger.getCustomerEntries(req.params.name);
    const balance = req.ledger.getCustomerBalance(req.params.name);
    res.json({ success: true, entries, balance });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Full snapshot used by the browser UI.
app.get('/api/state', (req, res) => {
  try {
    res.json({ success: true, ...req.ledger.getUiState() });
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

// Free LLM key (Groq, Gemini, OpenRouter) configured from the app
app.get('/api/settings/llm-key', (req, res) => {
  res.json({
    success: true,
    configured: Boolean(ACTIVE_LLM_KEY),
    provider: llm.provider,
    model: llm.model,
    source: llmKeyStore.source(),
  });
});

app.post('/api/settings/llm-key', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  if (llmKeyStore.source() === 'environment') {
    return res.status(409).json({
      success: false,
      error: 'Key server environment se aa rahi hai. Wahan badalni hogi.',
    });
  }

  try {
    llmKeyStore.set(req.body?.key);
    ACTIVE_LLM_KEY = llmKeyStore.get();
    llm = new LlmBrain({ apiKey: ACTIVE_LLM_KEY || undefined });
    console.log('[Settings] LLM key saved from the app');
    return res.json({
      success: true,
      configured: Boolean(ACTIVE_LLM_KEY),
      provider: llm.provider,
      model: llm.model,
      source: llmKeyStore.source(),
    });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/settings/llm-key', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  if (llmKeyStore.source() === 'environment') {
    return res.status(409).json({
      success: false,
      error: 'Key server environment se aa rahi hai. Wahan hataani hogi.',
    });
  }
  llmKeyStore.clear();
  ACTIVE_LLM_KEY = llmKeyStore.get();
  llm = new LlmBrain({ apiKey: ACTIVE_LLM_KEY || undefined });
  return res.json({ success: true, configured: Boolean(ACTIVE_LLM_KEY), source: llmKeyStore.source() });
});

// Text turn without a WebSocket (curl, judge script, accessibility fallback).
app.post('/api/text', async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ success: false, error: 'text is required' });
  const result = await agentFor(req.ledger).handleAsync(text);
  return res.json({ success: true, ...result, state: req.ledger.getUiState() });
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
    const entry = req.ledger.addEntry({ customerName, amount, type, date, note: note || null });
    const balance = req.ledger.getCustomerBalance(entry.customerName).balance;
    return res.json({ success: true, entry, balance, state: req.ledger.getUiState() });
  } catch (err) {
    return res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/entries/:id', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  const removed = req.ledger.deleteEntryById(req.params.id);
  if (!removed) return res.status(404).json({ success: false, error: 'Entry nahi mili.' });
  return res.json({ success: true, removed, state: req.ledger.getUiState() });
});

app.delete('/api/customers/:id', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  try {
    const removed = req.ledger.deleteCustomerById(req.params.id);
    if (!removed.customers) return res.status(404).json({ success: false, error: 'Grahak nahi mila.' });
    return res.json({ success: true, removed, state: req.ledger.getUiState() });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

app.patch('/api/customers/:id', (req, res) => {
  if (!isSameOrigin(req)) {
    return res.status(403).json({ success: false, error: 'Same-origin request required.' });
  }
  const updated = req.ledger.updateCustomerPhone(req.params.id, req.body?.phone);
  if (!updated) return res.status(404).json({ success: false, error: 'Grahak nahi mila.' });
  return res.json({ success: true, state: req.ledger.getUiState() });
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
    res.json({ success: true, range, ...req.ledger.getReport(from, today) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/activity', (req, res) => {
  try {
    res.json({ success: true, entries: req.ledger.getActivity(Number(req.query.limit) || 25) });
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
  req.ledger.resetAll();
  console.log('[Data] ledger cleared from the app');
  return res.json({ success: true, state: req.ledger.getUiState() });
});

app.post('/api/reminders/opt-in', (req, res) => {
  const name = String(req.body?.name || '').trim();
  const optedIn = Boolean(req.body?.optIn);
  if (!name) return res.status(400).json({ success: false, error: 'name is required' });
  const ok = req.ledger.setReminderOptIn(name, optedIn);
  return res.json({ success: ok, name, optIn: optedIn });
});

app.get('/api/reminders/preview/:name', (req, res) => {
  const agent = agentFor(req.ledger);
  const result = agent.handle(`${req.params.name} ko reminder bhejo`);
  res.json({ success: true, spoken: result.spoken, events: result.events });
});

app.post('/api/transcripts/purge', (req, res) => {
  const removed = req.ledger.purgeTranscripts();
  res.json({ success: true, purged: removed });
});

app.post('/api/reset', (req, res) => {
  if (!ALLOW_RESET) return res.status(403).json({ success: false, error: 'reset disabled' });
  req.ledger.resetAll();
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

function sendState(ws, storeLedger = ledger) {
  send(ws, 'ledger_summary', storeLedger.getUiState({ today: localYmd() }));
}

wss.on('connection', (clientWs, upgradeReq) => {
  const sessionId = randomUUID();
  const upgradeToken = readCookie(upgradeReq, SESSION_COOKIE);
  const upgradeSession = upgradeToken ? registry.getSession(upgradeToken) : null;
  if (googleAuth.enabled && !upgradeSession) {
    clientWs.close(4001, 'login_required');
    return;
  }
  const store = upgradeSession || registry.getStore('default');
  const storeLedger = registry.ledgerFor(store?.id || 'default');
  const agent = new KhataAgent({ ledger: storeLedger, brain: llm });
  let sttSocket = null;
  let sttCloseTimer = null;
  let previousTranscript = '';
  const seenSegments = new Set();

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
  sendState(clientWs, storeLedger);
  speak(clientWs, agent.disclosureText, sessionId);

  async function handleText(text) {
    if (!text || typeof text !== 'string') return;
    previousTranscript = text;
    send(clientWs, 'transcript', { text, is_final: true });

    const result = await agent.handleAsync(text);

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
    sendState(clientWs, storeLedger);
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
          await handleText(message.text);
          break;

        case 'get_ledger':
          sendState(clientWs, storeLedger);
          break;

        case 'reset':
          if (ALLOW_RESET) {
            storeLedger.resetAll();
            agent.lastEntryId = null;
            agent.pending = null;
            sendState(clientWs, storeLedger);
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
      // Customer names are the words Prisma is most likely to mishear, and a
      // wrong name writes a wrong ledger row. Feed the known names (and their
      // tokens) as keyterms, along with the shop topic and the previous turn.
      const customerNames = storeLedger.getCustomerSummary()
        .slice(0, 40)
        .map((row) => String(row.customer_name || '').trim())
        .filter(Boolean);
      const nameTokens = customerNames
        .flatMap((name) => name.split(/\s+/))
        .filter((word) => word.length >= 3);
      const keyterms = [...new Set([...customerNames, ...nameTokens])].slice(0, 120);

      const vad = {};
      if (process.env.GNANI_VAD_THRESHOLD) vad['x-vad-threshold'] = process.env.GNANI_VAD_THRESHOLD;
      if (process.env.GNANI_MIN_SPEECH_MS) vad['x-min-speech-ms'] = process.env.GNANI_MIN_SPEECH_MS;
      if (process.env.GNANI_MIN_SILENCE_MS) vad['x-min-silence-ms'] = process.env.GNANI_MIN_SILENCE_MS;
      if (process.env.GNANI_MIN_SEGMENT_MS) vad['x-min-segment-ms'] = process.env.GNANI_MIN_SEGMENT_MS;

      sttSocket = await stt.connect({
        model: 'prisma-v3.0',
        // Streaming takes one locale; GNANI_LANGUAGE lets a shop switch it
        // (e.g. bn-IN, ta-IN) without touching code.
        languageCode: process.env.GNANI_LANGUAGE || 'hi-IN',
        format: 'codemix',
        sampleRate: 16000,
        keyterms,
        topic: process.env.GNANI_TOPIC || 'kirana dukaan ka khata, udhaar aur jama hisaab',
        previousText: previousTranscript,
        vad,
      });
      framer.start();

      sttSocket.on('message', async (raw) => {
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
            // Prisma can resend a segment after a reconnect; the segment id
            // makes that idempotent so one sentence never becomes two entries.
            if (isFinal && payload.segment_id) {
              if (seenSegments.has(payload.segment_id)) return;
              seenSegments.add(payload.segment_id);
              if (seenSegments.size > 50) {
                const oldest = seenSegments.values().next().value;
                seenSegments.delete(oldest);
              }
            }
            send(clientWs, 'transcript', {
              text,
              is_final: isFinal,
              detected_language: payload.detected_language_code,
              latency_ms: payload.latency,
            });
            if (isFinal) await handleText(text);
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
      voice: process.env.GNANI_TTS_VOICE || 'Shivani',
      model: 'timbre-v3.0',
      language: process.env.GNANI_TTS_LANGUAGE || 'hi-IN',
      // Slower, articulate conversational speed (0.94) produces far more natural Indian prosody
      speed: Number(process.env.GNANI_TTS_SPEED || 0.94),
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
    const purged = registry.allLedgers()
      .reduce((total, storeLedger) => total + storeLedger.purgeTranscripts({ olderThanMinutes: RETENTION_MINUTES }), 0);
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
