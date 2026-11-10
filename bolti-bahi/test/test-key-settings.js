/**
 * In-app Gnani key: storage, secrecy, same-origin guard and live effect on health.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyStore } from '../lib/key-store.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3457;
const BASE = `http://127.0.0.1:${PORT}`;
const FAKE_KEY = 'vach_TEST_only_1234567890abcdefghijklmnop';

let passed = 0;
let failed = 0;

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const dir = mkdtempSync(join(tmpdir(), 'bb-key-'));
const dbPath = join(dir, 'khata.db');
const keyPath = join(dir, '.gnani-key');

const server = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(PORT),
    KHATA_DB: dbPath,
    GNANI_API_KEY: '',
    NODE_ENV: 'test',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
server.stdout.on('data', (d) => { serverLog += d.toString(); });
server.stderr.on('data', (d) => { serverLog += d.toString(); });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForServer() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return true;
    } catch { /* not up yet */ }
    await sleep(100);
  }
  return false;
}

async function json(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, options);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, headers: res.headers };
}

function cleanup() {
  try { server.kill(); } catch { /* already gone */ }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

try {
  console.log('\n🔑 IN-APP API KEY SETTINGS');

  const up = await waitForServer();
  check('server starts with no key', up, serverLog.slice(-300));
  if (!up) throw new Error('server did not start');

  const initial = await json('/api/settings');
  check('settings report no key initially', initial.body.configured === false);
  check('settings report source "none"', initial.body.source === 'none', initial.body.source);
  check('settings response is not cacheable', initial.headers.get('cache-control') === 'no-store');
  check('no key file exists yet', !existsSync(keyPath));

  // A cross-site form/fetch must not be able to install a key.
  const evil = await json('/api/settings/gnani-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
    body: JSON.stringify({ key: FAKE_KEY }),
  });
  check('cross-origin key write is rejected', evil.status === 403, String(evil.status));
  check('rejected write creates no key file', !existsSync(keyPath));

  const empty = await json('/api/settings/gnani-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ key: '   ' }),
  });
  check('empty key is rejected', empty.status === 400, String(empty.status));

  const saved = await json('/api/settings/gnani-key', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ key: FAKE_KEY }),
  });
  check('same-origin key save succeeds', saved.status === 200 && saved.body.configured === true);
  check('save reports source "app"', saved.body.source === 'app', saved.body.source);
  check('save response never echoes the key', !JSON.stringify(saved.body).includes(FAKE_KEY));

  check('key file is written', existsSync(keyPath));
  check('key file is owner-only (0600)', existsSync(keyPath) && (statSync(keyPath).mode & 0o777) === 0o600, existsSync(keyPath) ? (statSync(keyPath).mode & 0o777).toString(8) : 'missing');
  check('key file holds the key', existsSync(keyPath) && readFileSync(keyPath, 'utf8').trim() === FAKE_KEY);

  const afterSave = await json('/api/settings');
  check('settings never return the key', !JSON.stringify(afterSave.body).includes(FAKE_KEY));
  check('settings report configured', afterSave.body.configured === true);

  const health = await json('/api/health');
  check('health now reports STT available', health.body.stt === true);
  check('health now reports TTS available', health.body.tts === true);
  check('health never exposes the key', !JSON.stringify(health.body).includes(FAKE_KEY));

  const dbBytes = existsSync(dbPath) ? readFileSync(dbPath) : Buffer.alloc(0);
  check('key is never written into the ledger DB', !dbBytes.includes(FAKE_KEY));
  check('server log never contains the key', !serverLog.includes(FAKE_KEY));

  const removed = await json('/api/settings/gnani-key', {
    method: 'DELETE',
    headers: { Origin: BASE },
  });
  check('key removal succeeds', removed.status === 200 && removed.body.configured === false);
  check('key file is deleted', !existsSync(keyPath));

  const afterRemove = await json('/api/health');
  check('health reports STT unavailable again', afterRemove.body.stt === false);

  // Environment-managed keys are authoritative.
  const envStore = new KeyStore({ file: join(dir, 'unused-key'), envKey: FAKE_KEY });
  check('environment key takes precedence', envStore.get() === FAKE_KEY);
  check('environment source is reported', envStore.source() === 'environment');
} catch (err) {
  failed += 1;
  console.error(`  ❌ unexpected error: ${err.message}`);
} finally {
  cleanup();
}

console.log(`\n${failed === 0 ? '✅' : '❌'} API key settings: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
