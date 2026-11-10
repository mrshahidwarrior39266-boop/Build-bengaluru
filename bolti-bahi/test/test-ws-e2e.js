/**
 * End-to-end WebSocket test — the exact path a judge's microphone takes.
 *
 * Boots the real server (no API keys, no network), speaks through ws, and
 * checks the ledger over REST. Proves that control frames are routed, that the
 * first turn is an AI disclosure, that latency stays under 2 seconds, that
 * transcripts are encrypted on disk, and that retention purge works.
 *
 * Run: node test/test-ws-e2e.js
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
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
    const srv = createServer();
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

function makeClient(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];

  const check = () => {
    for (const waiter of [...waiters]) {
      const found = messages.slice(waiter.from).find(waiter.predicate);
      if (found) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(found);
      }
    }
  };

  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
      check();
    } catch { /* ignore non-JSON */ }
  });

  return {
    ws,
    messages,
    opened: new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    }),
    send(payload) {
      ws.send(JSON.stringify(payload));
    },
    waitFor(predicate, { from = 0, timeoutMs = 6000 } = {}) {
      const existing = messages.slice(from).find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, from, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) {
            waiters.splice(idx, 1);
            reject(new Error('timeout waiting for message'));
          }
        }, timeoutMs);
      });
    },
    close() { try { ws.close(); } catch { /* noop */ } },
  };
}

const dir = mkdtempSync(join(tmpdir(), 'khata-e2e-'));
const dbPath = join(dir, 'khata.db');
const port = await freePort();

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    KHATA_DB: dbPath,
    NODE_ENV: 'test',
    ENABLE_RESET: '1',
    GNANI_API_KEY: '',
    LLM_API_KEY: '',
    TRANSCRIPT_RETENTION_MINUTES: '120',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

let client;
try {
  const health = await waitForHealth(port);
  console.log('\n🔌 WEB SOCKET END-TO-END\n');
  eq(health.ok, true, 'Health endpoint responds');
  eq(health.stt, false, 'Reports STT missing honestly (no key in test)');

  await fetch(`http://127.0.0.1:${port}/api/reset`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });

  client = makeClient(`ws://127.0.0.1:${port}/ws`);
  await client.opened;
  const chat = (text) => {
    const from = client.messages.length;
    client.send({ type: 'text_input', text });
    return client.waitFor((m) => m.type === 'response_text', { from })
      .then((reply) => ({ reply, messages: client.messages.slice(from), from }));
  };

  // 1. First turn must identify the AI (Responsible AI rule).
  const first = await client.waitFor((m) => m.type === 'ai_disclosure');
  ok(/AI/i.test(first.text), 'First turn discloses that it is an AI', first.text);
  eq(client.messages[0].type, 'ai_disclosure', 'Disclosure is literally the first message');
  const initialSummary = await client.waitFor((m) => m.type === 'ledger_summary');
  eq(initialSummary.summary.totalOutstanding, 0, 'Empty ledger starts at zero (no fake demo balances)');

  // 2. Control frames are routed (the original server dropped every JSON frame).
  const compound = await chat('Ramesh ka 340 udhaar, kal 200 diya tha');
  const updates = compound.messages.filter((m) => m.type === 'ledger_update').map((m) => m.transaction);
  eq(updates.length, 2, 'Compound sentence produces two ledger updates');
  eq(updates[0].amount, 340, 'First update amount 340');
  eq(updates[0].type, 'credit', 'First update is credit');
  eq(updates[1].amount, 200, 'Second update amount 200');
  eq(updates[1].type, 'payment', 'Second update is payment');
  ok(compound.reply.latencyMs < 2000, `Answer latency ${compound.reply.latencyMs}ms < 2000ms`);
  ok(/340/.test(compound.reply.text), 'Spoken text confirms 340', compound.reply.text);

  const summaryAfter = await client.waitFor((m) => m.type === 'ledger_summary', { from: compound.from });
  const ramesh = summaryAfter.customers.find((c) => c.name === 'Ramesh');
  eq(ramesh.balance, 140, 'UI snapshot shows Ramesh balance 140');

  // 3. Correction over the wire.
  await chat('Suresh ka 500 udhaar');
  const correction = await chat('nahi, 430');
  const corrected = correction.messages.find((m) => m.type === 'ledger_update');
  eq(corrected.transaction.amount, 430, 'Correction updates Suresh to 430');
  eq(corrected.action, 'entry_corrected', 'Correction is labelled as a correction');

  // 4. Spoken answer within the 2s budget (only one Ramesh exists so far).
  const query = await chat('Ramesh ka total?');
  const q = query.messages.find((m) => m.type === 'query_response');
  eq(q?.value, 140, 'Query returns the exact balance 140');
  ok(query.reply.latencyMs < 2000, `Query latency ${query.reply.latencyMs}ms < 2000ms`);

  // 5. Today's credit matches the ledger, correction included.
  const today = await chat('Aaj kitna udhaar gaya?');
  const todayCredit = today.messages.find((m) => m.type === 'query_response');
  eq(todayCredit?.value, 770, 'Today credit = 340 + 430 after the correction');

  // 6. Shared-name question then answer.
  await chat('Ramesh Kumar ka 50 udhaar');
  const ambiguous = await chat('Ramesh ka 10 udhaar');
  const clarification = ambiguous.messages.find((m) => m.type === 'clarification_needed');
  ok(Boolean(clarification), 'Shared name asks a question');
  ok(/Ramesh Kumar/.test(clarification?.question || ''), 'Question names both customers', clarification?.question);

  const answered = await chat('pehla');
  const applied = answered.messages.find((m) => m.type === 'ledger_update');
  eq(applied?.transaction?.customer, 'Ramesh', 'Answer applies to the chosen Ramesh');
  eq(applied?.transaction?.amount, 10, 'Chosen Ramesh receives the pending ₹10');

  // 7. An ambiguous balance query asks instead of guessing, then answers.
  const ambiguousQuery = await chat('Ramesh ka total?');
  const ambiguityAsked = ambiguousQuery.messages.find((m) => m.type === 'clarification_needed');
  ok(Boolean(ambiguityAsked), 'Ambiguous balance query asks which customer');
  const chosenForQuery = await chat('pehla');
  const answeredQuery = chosenForQuery.messages.find((m) => m.type === 'query_response');
  eq(answeredQuery?.value, 150, 'Chosen customer balance is 150');

  // 7. Honest degradation when the Gnani key is absent.
  const from = client.messages.length;
  client.send({ type: 'audio_start' });
  const unavailable = await client.waitFor((m) => m.type === 'stt_unavailable', { from });
  ok(/key|recognition|sampark/i.test(unavailable.message), 'Missing STT key is reported, not faked');

  // 8. Reminder guardrail over HTTP.
  const blocked = await (await fetch(`http://127.0.0.1:${port}/api/reminders/preview/Suresh`)).json();
  eq(blocked.events[0].allowed, false, 'Reminder blocked without opt-in');
  eq(blocked.events[0].reason, 'not_opted_in', 'Refusal reason is opt-in');

  const optIn = await (await fetch(`http://127.0.0.1:${port}/api/reminders/opt-in`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Suresh', optIn: true }),
  })).json();
  eq(optIn.success, true, 'Opt-in recorded for an unambiguous customer');

  const allowed = await (await fetch(`http://127.0.0.1:${port}/api/reminders/preview/Suresh`)).json();
  eq(allowed.events[0].allowed, true, 'Reminder allowed after opt-in');

  const ambiguousReminder = await (await fetch(`http://127.0.0.1:${port}/api/reminders/preview/Ramesh`)).json();
  eq(ambiguousReminder.events[0].allowed, false, 'Ambiguous customer never receives a reminder');

  // 9. Transcripts are encrypted at rest.
  const rawDb = Buffer.concat([
    existsSync(dbPath) ? readFileSync(dbPath) : Buffer.alloc(0),
    existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`) : Buffer.alloc(0),
  ]).toString('latin1');
  ok(!rawDb.includes('Ramesh ka 340 udhaar'), 'Transcript is not stored in plaintext on disk');
  ok(!rawDb.includes('kal 200 diya'), 'Second clause transcript is encrypted too');
  ok(rawDb.includes('enc:v1:'), 'Ciphertext envelope present in the database file');

  // 10. Retention purge removes transcript text.
  const purged = await (await fetch(`http://127.0.0.1:${port}/api/transcripts/purge`, { method: 'POST' })).json();
  ok(purged.purged >= 1, `Purge removed ${purged.purged} transcripts`);
  const ledgerAfter = await (await fetch(`http://127.0.0.1:${port}/api/ledger`)).json();
  ok(ledgerAfter.entries.every((e) => e.note === null), 'No transcript text remains after purge');
  ok(ledgerAfter.entries.every((e) => e.amount > 0), 'Amounts survive the purge (ledger still correct)');
} catch (err) {
  failed += 1;
  console.log(`  ❌ E2E aborted: ${err.message}`);
  if (serverLog) console.log(`\n--- server log ---\n${serverLog}`);
} finally {
  client?.close();
  child.kill('SIGTERM');
  await new Promise((r) => setTimeout(r, 250));
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* noop */ }
}

console.log('\n' + '═'.repeat(52));
console.log(`📊 E2E TESTS: ${passed}/${passed + failed} passed, ${failed} failed`);
console.log('═'.repeat(52));
if (failed > 0) {
  if (serverLog) console.log(`\n--- server log ---\n${serverLog}`);
  process.exit(1);
}
console.log('🎉 Full voice-session path verified.\n');
