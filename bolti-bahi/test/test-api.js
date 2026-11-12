/**
 * Manual-entry and data-hygiene API: the routes the app's own forms use.
 *
 * Every assertion is about observable HTTP behaviour against a real server and
 * a throwaway database, so a passing run also proves the ledger starts empty
 * (no seeded names) and that an entry can be deleted again.
 *
 * Run: node test/test-api.js
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

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

const dir = mkdtempSync(join(tmpdir(), 'khata-api-'));
const port = await freePort();
const base = `http://127.0.0.1:${port}`;

const child = spawn(process.execPath, ['server.js'], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    KHATA_DB: join(dir, 'khata.db'),
    NODE_ENV: 'test',
    GNANI_API_KEY: '',
    LLM_API_KEY: '',
    ENABLE_RESET: '0',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverLog = '';
child.stdout.on('data', (d) => { serverLog += d.toString(); });
child.stderr.on('data', (d) => { serverLog += d.toString(); });

const json = async (path, options = {}) => {
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  return { status: res.status, body: await res.json() };
};

try {
  await waitForHealth(port);
  console.log('\n📝 MANUAL ENTRY & DATA API\n');

  // 1. A brand-new ledger must be empty: no sample customers, no fake balances.
  const empty = await json('/api/state');
  eq(empty.body.customers.length, 0, 'Fresh ledger has no customers');
  eq(empty.body.summary.totalOutstanding, 0, 'Fresh ledger outstanding is zero');
  eq((await json('/api/activity')).body.entries.length, 0, 'Fresh ledger has no activity');

  // 1b. Regression: "likh do" is a command, not a ₹2 entry. This is what used
  // to fill the ledger with junk rows nobody could delete.
  const command = await json('/api/text', {
    method: 'POST',
    body: JSON.stringify({ text: 'wo baat likh do' }),
  });
  eq((command.body.events || []).filter((e) => e.type === 'entry').length, 0, '“likh do” creates no entry');
  eq((await json('/api/state')).body.customers.length, 0, '“likh do” creates no customer');

  const adjust = await json('/api/text', {
    method: 'POST',
    body: JSON.stringify({ text: 'pichhle wale ka hisaab adjust kar do' }),
  });
  eq((adjust.body.events || []).filter((e) => e.type === 'entry').length, 0, '“adjust kar do” creates no entry');

  // …while a real two-word number still parses.
  const twoHundred = await json('/api/text', {
    method: 'POST',
    body: JSON.stringify({ text: 'do sau udhaar Meena' }),
  });
  const twoHundredEntry = (twoHundred.body.events || []).find((e) => e.type === 'entry');
  eq(twoHundredEntry?.entry?.amount, 200, '“do sau” still parses as ₹200');
  await json('/api/data', { method: 'DELETE', body: JSON.stringify({ confirm: 'DELETE' }) });

  // 2. Manual credit, then a payment against it.
  const credit = await json('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ customerName: 'Asha', amount: 250, type: 'credit', note: 'saman' }),
  });
  eq(credit.status, 200, 'Manual credit is accepted');
  eq(credit.body.balance, 250, 'Balance after credit is 250');
  eq(credit.body.state.customers.length, 1, 'Snapshot contains exactly the one real customer');
  eq(credit.body.state.customers[0].name, 'Asha', 'Customer name is what was typed');

  const payment = await json('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ customerName: 'asha', amount: 100, type: 'payment' }),
  });
  eq(payment.status, 200, 'Manual payment is accepted');
  eq(payment.body.balance, 150, 'Lower-case name reuses the same customer (balance 150)');

  // 3. Rejections must not create rows.
  const zero = await json('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ customerName: 'Bina', amount: 0, type: 'credit' }),
  });
  eq(zero.status, 400, 'Zero amount is rejected');

  const digitsOnly = await json('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ customerName: '12345', amount: 50, type: 'credit' }),
  });
  eq(digitsOnly.status, 400, 'Digits-only name is rejected');

  const noType = await json('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ customerName: 'Bina', amount: 50 }),
  });
  eq(noType.status, 400, 'Missing credit/payment is rejected');

  const badDate = await json('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ customerName: 'Bina', amount: 50, type: 'credit', date: '11-11-2026' }),
  });
  eq(badDate.status, 400, 'Wrongly formatted date is rejected');

  const stillOne = await json('/api/state');
  eq(stillOne.body.customers.length, 1, 'Rejected writes created no customers');

  // 4. Cross-origin writes are refused.
  const foreign = await json('/api/entries', {
    method: 'POST',
    headers: { Origin: 'https://evil.example' },
    body: JSON.stringify({ customerName: 'Mallory', amount: 10, type: 'credit' }),
  });
  eq(foreign.status, 403, 'Cross-origin entry write is refused');

  // 5. Report totals for today.
  const report = await json('/api/reports?range=today');
  eq(report.status, 200, 'Report responds');
  eq(report.body.totals.credit, 250, 'Report counts ₹250 credit');
  eq(report.body.totals.payment, 100, 'Report counts ₹100 payment');
  eq(report.body.totals.net, 150, 'Report net is ₹150');
  eq(report.body.topOutstanding[0]?.name, 'Asha', 'Top outstanding names the real customer');

  // 6. Activity feed is newest first and carries the id needed to delete.
  const activity = await json('/api/activity');
  eq(activity.body.entries.length, 2, 'Activity lists both entries');
  eq(activity.body.entries[0].type, 'payment', 'Activity is newest first');
  ok(Boolean(activity.body.entries[0].id), 'Activity rows expose their id');

  // 7. Delete a single entry.
  const del = await json(`/api/entries/${activity.body.entries[0].id}`, { method: 'DELETE' });
  eq(del.status, 200, 'Entry delete succeeds');
  eq(del.body.state.customers[0].balance, 250, 'Deleting the payment restores balance 250');
  eq(del.body.state.customers.length, 1, 'Customer survives deleting one entry');

  const missing = await json('/api/entries/does-not-exist', { method: 'DELETE' });
  eq(missing.status, 404, 'Deleting an unknown entry is a 404');

  // 8. Delete a customer and their history.
  const customerId = del.body.state.customers[0].id;
  const delCustomer = await json(`/api/customers/${customerId}`, { method: 'DELETE' });
  eq(delCustomer.status, 200, 'Customer delete succeeds');
  eq(delCustomer.body.state.customers.length, 0, 'Customer list is empty again');
  eq((await json('/api/activity')).body.entries.length, 0, 'Customer history went with it');

  // 9. Clear-all needs an explicit confirmation.
  await json('/api/entries', {
    method: 'POST',
    body: JSON.stringify({ customerName: 'Kabir', amount: 75, type: 'credit' }),
  });
  const refused = await json('/api/data', { method: 'DELETE', body: JSON.stringify({}) });
  eq(refused.status, 400, 'Clear-all without confirmation is refused');
  eq((await json('/api/state')).body.customers.length, 1, 'Refused clear-all keeps the data');

  const cleared = await json('/api/data', {
    method: 'DELETE',
    body: JSON.stringify({ confirm: 'DELETE' }),
  });
  eq(cleared.status, 200, 'Clear-all with confirmation succeeds');
  eq(cleared.body.state.customers.length, 0, 'Clear-all leaves an empty ledger');
} catch (err) {
  failed += 1;
  console.error('  ❌ Unexpected error:', err.message);
  if (serverLog) console.error(serverLog.slice(-1500));
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
}

console.log(`\n${failed === 0 ? '✅' : '❌'} API tests: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
