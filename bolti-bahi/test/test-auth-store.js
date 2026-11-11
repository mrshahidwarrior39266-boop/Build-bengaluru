/**
 * Store accounts: Google sign-in, per-store isolation, and the auth gate.
 *
 * Google itself is replaced by a local stub, so this runs offline and needs no
 * client secret. It still exercises the real cookie, state, session and ledger
 * code paths the deployed app uses.
 *
 * Run: node test/test-auth-store.js
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

let passed = 0;
let failed = 0;
function ok(condition, name, extra = '') {
  if (condition) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForHealth(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (res.ok) return await res.json();
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('server did not become healthy');
}

function cookiesFrom(response) {
  const raw = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const jar = {};
  for (const line of raw) {
    const [pair] = String(line).split(';');
    const idx = pair.indexOf('=');
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}

// ------------------------------------------------------------- Google stub
let currentSub = 'google-1';
const google = createServer((req, res) => {
  if (req.url.startsWith('/token')) {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ access_token: 'stub-access-token', token_type: 'Bearer' }));
    });
    return;
  }
  if (req.url.startsWith('/userinfo')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      sub: currentSub,
      email: `${currentSub}@example.com`,
      name: currentSub === 'google-1' ? 'Asha Verma' : 'Ravi Kumar',
      email_verified: true,
    }));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((resolve) => google.listen(0, '127.0.0.1', resolve));
const googleBase = `http://127.0.0.1:${google.address().port}`;

const dir = mkdtempSync(join(tmpdir(), 'khata-auth-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    KHATA_DB: join(dir, 'default.db'),
    STORE_DB: join(dir, 'stores.db'),
    STORE_DATA_DIR: join(dir, 'stores'),
    NODE_ENV: 'test',
    GNANI_API_KEY: '',
    LLM_API_KEY: '',
    GOOGLE_CLIENT_ID: 'test-client-id',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    GOOGLE_AUTH_URL: `${googleBase}/authorize`,
    GOOGLE_TOKEN_URL: `${googleBase}/token`,
    GOOGLE_USERINFO_URL: `${googleBase}/userinfo`,
    GOOGLE_REDIRECT_URI: `${base}/auth/google/callback`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

const json = async (path, { cookie, ...options } = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
  });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body, headers: res.headers };
};

async function signIn({ expectIsolated = false } = {}) {
  const start = await fetch(`${base}/auth/google`, { redirect: 'manual' });
  const location = new URL(start.headers.get('location'));
  const state = location.searchParams.get('state');
  const jar = cookiesFrom(start);
  const callback = await fetch(
    `${base}/auth/google/callback?code=stub-code&state=${state}`,
    { redirect: 'manual', headers: { Cookie: `bb_oauth_state=${jar.bb_oauth_state}` } },
  );
  const session = cookiesFrom(callback).bb_session || '';
  return { start, location, state, callback, cookie: `bb_session=${session}`, isolated: expectIsolated };
}

try {
  await waitForHealth(port);
  console.log('\n🔐 STORE ACCOUNTS & GOOGLE SIGN-IN\n');

  // 1. Health stays public; the ledger does not.
  eq((await json('/api/health')).status, 200, 'Health is public');
  const anonymous = await json('/api/state');
  eq(anonymous.status, 401, 'Ledger requires a session');
  eq(anonymous.body.error, 'login_required', 'Anonymous request says login_required');

  // 2. The redirect goes to Google with a state nonce.
  const first = await signIn();
  eq(first.start.status, 302, 'Sign-in redirects');
  eq(`${first.location.origin}${first.location.pathname}`, `${googleBase}/authorize`, 'Redirect targets the Google authorize URL');
  eq(first.location.searchParams.get('client_id'), 'test-client-id', 'Client id is passed');
  eq(first.location.searchParams.get('redirect_uri'), `${base}/auth/google/callback`, 'Redirect URI is passed');
  ok(Boolean(first.state && first.state.length > 10), 'State nonce is present');
  eq(first.callback.status, 302, 'Callback completes');
  eq(first.callback.headers.get('location'), '/', 'Callback lands on the app');

  // 3. A forged callback is refused.
  const forged = await fetch(`${base}/auth/google/callback?code=x&state=wrong`, {
    redirect: 'manual',
    headers: { Cookie: 'bb_oauth_state=right' },
  });
  eq(forged.status, 400, 'Mismatched state is rejected');

  // 4. Session reports the new shop and asks for its name.
  const session1 = await json('/api/session', { cookie: first.cookie });
  eq(session1.body.authenticated, true, 'Session is authenticated');
  eq(session1.body.store.needsName, true, 'New shop needs a name');
  eq(session1.body.owner.email, 'google-1@example.com', 'Owner email is stored');

  eq((await json('/api/store', {
    method: 'POST',
    cookie: first.cookie,
    body: JSON.stringify({ name: 'X' }),
  })).status, 400, 'One-letter shop name is rejected');

  const named = await json('/api/store', {
    method: 'POST',
    cookie: first.cookie,
    body: JSON.stringify({ name: 'Sharma Kirana Store' }),
  });
  eq(named.status, 200, 'Shop name is saved');
  eq((await json('/api/session', { cookie: first.cookie })).body.store.name, 'Sharma Kirana Store', 'Shop name comes back');

  // 5. First shop writes an entry.
  const entry1 = await json('/api/entries', {
    method: 'POST',
    cookie: first.cookie,
    body: JSON.stringify({ customerName: 'Meena', amount: 200, type: 'credit' }),
  });
  eq(entry1.status, 200, 'Signed-in shop can write');
  eq(entry1.body.state.customers.length, 1, 'First shop has one customer');

  // 6. A second Google account gets a separate, empty ledger.
  currentSub = 'google-2';
  const second = await signIn({ expectIsolated: true });
  const session2 = await json('/api/session', { cookie: second.cookie });
  eq(session2.body.authenticated, true, 'Second account signs in');
  const state2 = await json('/api/state', { cookie: second.cookie });
  eq(state2.body.customers.length, 0, 'Second shop cannot see the first shop’s customers');
  eq(state2.body.summary.totalOutstanding, 0, 'Second shop starts at zero');

  await json('/api/entries', {
    method: 'POST',
    cookie: second.cookie,
    body: JSON.stringify({ customerName: 'Kabir', amount: 50, type: 'credit' }),
  });
  const state2After = await json('/api/state', { cookie: second.cookie });
  eq(state2After.body.customers[0].name, 'Kabir', 'Second shop keeps its own customer');
  const state1After = await json('/api/state', { cookie: first.cookie });
  eq(state1After.body.customers.length, 1, 'First shop still has exactly its own customer');
  eq(state1After.body.customers[0].name, 'Meena', 'First shop data is untouched');

  // 7. Cross-origin writes stay refused even with a valid session.
  const foreign = await json('/api/entries', {
    method: 'POST',
    cookie: first.cookie,
    headers: { Origin: 'https://evil.example' },
    body: JSON.stringify({ customerName: 'Mallory', amount: 10, type: 'credit' }),
  });
  eq(foreign.status, 403, 'Cross-origin write refused with a session');

  // 8. WebSocket without a session is closed.
  const wsClosed = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const timer = setTimeout(() => resolve('timeout'), 4000);
    ws.on('close', (code) => { clearTimeout(timer); resolve(code); });
    ws.on('error', () => { clearTimeout(timer); resolve('error'); });
  });
  ok(wsClosed === 4001 || wsClosed === 'error', 'Unauthenticated WebSocket is refused', String(wsClosed));

  // 9. Logout really ends the session.
  const out = await json('/auth/logout', { method: 'POST', cookie: first.cookie });
  eq(out.status, 200, 'Logout succeeds');
  eq((await json('/api/state', { cookie: first.cookie })).status, 401, 'Old cookie no longer works');
} catch (err) {
  failed += 1;
  console.error('  ❌ Unexpected error:', err.message);
  if (serverLog) console.error(serverLog.slice(-1200));
} finally {
  child.kill('SIGTERM');
  google.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✅' : '❌'} Store accounts: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
