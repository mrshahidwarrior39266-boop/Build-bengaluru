/**
 * Intention + number understanding tests (offline, no API key, no network).
 *
 * Every assertion here is about behaviour a judge can trigger by speaking:
 * exact amount, credit vs payment, relative date, corrections, ambiguity,
 * questions and refusals.
 *
 * Run: node test/test-intent.js
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LedgerDB } from '../lib/ledger-db.js';
import { KhataAgent } from '../lib/agent.js';
import { parseIntent } from '../lib/intent-parser.js';
import { scanAmounts, normalizeSpokenText } from '../lib/hindi-numbers.js';
import { isCompliantSpeech } from '../lib/speech-guard.js';

let passed = 0;
let failed = 0;

function ok(condition, name, extra = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✅ ${name}`);
  } else {
    failed += 1;
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`);
  }
}

function eq(actual, expected, name) {
  ok(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const NOW = new Date(2026, 10, 10, 12, 0, 0); // 10 Nov 2026, local
const TODAY = '2026-11-10';
const YESTERDAY = '2026-11-09';
const DAY_BEFORE = '2026-11-08';

function amountOf(text) {
  const { amounts } = scanAmounts(normalizeSpokenText(text));
  return amounts.length ? amounts[0].value : null;
}

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'khata-intent-'));
  const ledger = new LedgerDB(join(dir, 'test.db'));
  const agent = new KhataAgent({ ledger, now: () => NOW });
  return {
    ledger,
    agent,
    cleanup() {
      ledger.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const entries = (result) => result.events.filter((e) => e.type === 'entry').map((e) => e.entry);

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n🔢 SPOKEN NUMBERS\n');
// ─────────────────────────────────────────────────────────────────────────────
const numberCases = [
  ['teen sau chaalis', 340],
  ['paanch sau', 500],
  ['ek hazaar', 1000],
  ['do hazaar paanch sau', 2500],
  ['bees', 20],
  ['sau', 100],
  ['nau sau', 900],
  ['dedh sau', 150],
  ['dhai sau', 250],
  ['sawa sau', 125],
  ['sawa do sau', 225],
  ['paune do sau', 175],
  ['saadhe teen sau', 350],
  ['three-forty', 340],
  ['three hundred forty', 340],
  ['340', 340],
  ['३४०', 340],
  ['दो सौ चालीस', 240],
  ['1,20,000', 120000],
  ['1.5 hazaar', 1500],
  ['5k', 5000],
  ['750 rupees', 750],
];

for (const [text, expected] of numberCases) {
  eq(amountOf(text), expected, `"${text}" → ${expected}`);
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n🧾 ENTRY UNDERSTANDING\n');
// ─────────────────────────────────────────────────────────────────────────────

{
  const { agent, cleanup } = setup();
  const r = agent.handle('Ramesh ka 340 udhaar');
  const e = entries(r);
  eq(e.length, 1, 'Single credit creates one entry');
  eq(e[0].amount, 340, 'Exact amount 340');
  eq(e[0].type, 'credit', 'Direction credit');
  eq(e[0].date, TODAY, 'Date defaults to today');
  eq(e[0].customerName, 'Ramesh', 'Customer name captured');
  ok(/340/.test(r.spoken), 'Spoken confirmation mentions amount', r.spoken);
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('Ramesh ka 340 udhaar, kal 200 diya tha');
  const e = entries(r);
  eq(e.length, 2, 'Compound sentence creates two entries');
  eq(e[0].amount, 340, 'Credit amount 340');
  eq(e[0].type, 'credit', 'First entry is credit');
  eq(e[0].date, TODAY, 'Credit dated today');
  eq(e[1].amount, 200, 'Payment amount 200');
  eq(e[1].type, 'payment', 'Second entry is payment');
  eq(e[1].date, YESTERDAY, '"kal" resolves to yesterday');
  eq(agent.ledger.getCustomerBalance('Ramesh').balance, 140, 'Net balance 140');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('Ramesh ka 340 udhaar. kal 200 diya tha');
  eq(entries(r).length, 2, 'Period-separated compound still splits');
  eq(agent.ledger.getCustomerBalance('Ramesh').balance, 140, 'Period-separated balance 140');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('arre Ramesh bhai ka teen sau chaalis udhaar likh do');
  const e = entries(r);
  eq(e.length, 1, 'Noise words do not create entries');
  eq(e[0].amount, 340, 'Spoken number under noise = 340');
  eq(e[0].customerName, 'Ramesh', 'Filler words stripped from name');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  agent.handle('Ramesh ne 200 diya');
  eq(agent.ledger.getCustomerBalance('Ramesh').balance, -200, 'Payment with no prior credit shows advance');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('Suresh ne payment kar diya 300 ka');
  const e = entries(r);
  eq(e[0].type, 'payment', 'Hinglish payment direction');
  eq(e[0].amount, 300, 'Payment amount 300');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('Mahesh credit 750 rupees');
  eq(entries(r)[0].type, 'credit', 'English credit direction');
  eq(entries(r)[0].amount, 750, 'English amount 750');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('Suresh ka 500 udhaar hai parso');
  eq(entries(r)[0].date, DAY_BEFORE, '"parso" resolves to day before yesterday');
  cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n✏️  CORRECTIONS\n');
// ─────────────────────────────────────────────────────────────────────────────

{
  const { agent, ledger, cleanup } = setup();
  agent.handle('Ramesh ka 500 udhaar');
  const r = agent.handle('nahi, 430');
  const e = entries(r);
  eq(e.length, 1, 'Correction produces an updated entry');
  eq(e[0].amount, 430, 'Corrected amount 430');
  eq(e[0].corrected_from, 500, 'Audit trail keeps old amount 500');
  eq(ledger.getCustomerBalance('Ramesh').balance, 430, 'Balance reflects correction');
  cleanup();
}

{
  const { agent, ledger, cleanup } = setup();
  agent.handle('Suresh ka 500 udhaar');
  agent.handle('Ramesh ka 100 udhaar');
  agent.handle('nahi, 430');
  eq(ledger.getCustomerBalance('Suresh').balance, 500, 'Correction does not touch an older customer');
  eq(ledger.getCustomerBalance('Ramesh').balance, 430, 'Correction applies to the latest spoken entry');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('nahi, 430');
  eq(r.intent, 'correct', 'Correction with no history is still a correction turn');
  ok(/koi entry nahi/i.test(r.spoken), 'Empty-ledger correction explained politely');
  cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n❓ QUESTIONS\n');
// ─────────────────────────────────────────────────────────────────────────────

{
  const { agent, cleanup } = setup();
  agent.handle('Ramesh ka 340 udhaar');
  agent.handle('Ramesh ne 200 diya');
  const r = agent.handle('Ramesh ka total?');
  eq(r.intent, 'query', 'Balance question detected');
  eq(r.events.find((e) => e.type === 'query').value, 140, 'Balance answer is 140');
  ok(/140/.test(r.spoken), 'Spoken answer contains the amount', r.spoken);
  cleanup();
}

{
  const { agent, cleanup } = setup();
  agent.handle('Ramesh ka 340 udhaar');
  const r = agent.handle('Aaj kitna udhaar gaya?');
  eq(r.events.find((e) => e.type === 'query').value, 340, 'Today credit summary = 340');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  agent.handle('Ramesh ka 340 udhaar');
  agent.handle('Ramesh ne 200 diya');
  const r = agent.handle('Aaj kitna jama hua?');
  eq(r.events.find((e) => e.type === 'query').value, 200, 'Today payment summary = 200');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  agent.handle('Ramesh ka 340 udhaar');
  agent.handle('Suresh ka 900 udhaar');
  const r = agent.handle('kiski sabse zyada baaki hai');
  eq(r.events.find((e) => e.type === 'query').customer, 'Suresh', 'Top debtor is Suresh');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  agent.handle('Ramesh ka 340 udhaar');
  agent.handle('Suresh ka 900 udhaar');
  const r = agent.handle('kul kitna udhaar baaki hai');
  eq(r.events.find((e) => e.type === 'query').value, 1240, 'Total outstanding = 1240');
  cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n👥 SHARED NAMES\n');
// ─────────────────────────────────────────────────────────────────────────────

{
  const { agent, ledger, cleanup } = setup();
  ledger.addEntry({ customerName: 'Ramesh', amount: 100, type: 'credit', date: TODAY, note: 'seed' });
  ledger.addEntry({ customerName: 'Ramesh Kumar', amount: 50, type: 'credit', date: TODAY, note: 'seed' });

  const r = agent.handle('Ramesh ka 100 udhaar');
  eq(r.intent, 'clarify', 'Shared name triggers a question');
  const options = r.events[0].options || [];
  eq(options.length, 2, 'Question offers both customers');
  ok(/Ramesh Kumar/.test(r.spoken), 'Question names the second customer', r.spoken);

  const followUp = agent.handle('pehla');
  const e = entries(followUp);
  eq(e.length, 1, 'Answer "pehla" applies the pending entry');
  eq(e[0].customerName, 'Ramesh', 'Applied to the first Ramesh');
  eq(ledger.getCustomerBalance('Ramesh').balance, 200, 'First Ramesh balance now 200');
  eq(ledger.getCustomerBalance('Ramesh Kumar').balance, 50, 'Second Ramesh untouched');
  cleanup();
}

{
  const { agent, ledger, cleanup } = setup();
  ledger.addEntry({ customerName: 'Ramesh', amount: 100, type: 'credit', date: TODAY, note: 'seed' });

  const r = agent.handle('Ramesh Kumar ka 60 udhaar');
  eq(r.intent, 'entry', 'Longer distinct name is not merged into the shorter one');
  eq(entries(r)[0].customerName, 'Ramesh Kumar', 'New customer created for Ramesh Kumar');
  eq(ledger.getCustomerBalance('Ramesh').balance, 100, 'Short-name ledger untouched');
  cleanup();
}

{
  const { agent, ledger, cleanup } = setup();
  ledger.addEntry({ customerName: 'Ramesh', amount: 100, type: 'credit', date: TODAY, note: 'seed' });
  ledger.addEntry({ customerName: 'Ramesh Kumar', amount: 50, type: 'credit', date: TODAY, note: 'seed' });

  const r = agent.handle('Ramesh Kumar ka 25 udhaar');
  eq(r.intent, 'entry', 'Full name skips the ambiguity question');
  eq(ledger.getCustomerBalance('Ramesh Kumar').balance, 75, 'Applied to Ramesh Kumar');
  cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n🗣️  CLARIFYING A MISSING SLOT\n');
// ─────────────────────────────────────────────────────────────────────────────

{
  const { agent, cleanup } = setup();
  const r = agent.handle('200 udhaar');
  eq(r.intent, 'clarify', 'Missing customer triggers a question');
  const followUp = agent.handle('Suresh');
  eq(entries(followUp)[0].customerName, 'Suresh', 'Name answer completes the entry');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('Ramesh 250');
  eq(r.intent, 'clarify', 'Missing direction triggers a question');
  const followUp = agent.handle('jama');
  eq(entries(followUp)[0].type, 'payment', 'Direction answer applies payment');
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const r = agent.handle('Ramesh ka 0 udhaar');
  ok(r.intent !== 'entry' && r.intent !== 'entries', 'Zero amount is rejected, not ledgered');
  eq(agent.ledger.getCustomerSummary().length, 0, 'Rejected amount creates no customer');
  cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n🛡️  GUARDRAILS\n');
// ─────────────────────────────────────────────────────────────────────────────

{
  const { agent, cleanup } = setup();
  const lending = agent.handle('Ramesh ko 5000 ka loan de do');
  eq(lending.intent, 'refuse', 'Lending request refused');
  ok(/loan|byaj|udhaar/i.test(lending.spoken), 'Refusal explains scope');
  eq(entries(lending).length, 0, 'No ledger entry for a lending request');

  const health = agent.handle('Ramesh ko bukhar ki dawa do');
  eq(health.intent, 'refuse', 'Health advice refused');
  eq(entries(health).length, 0, 'No ledger entry for a health request');
  cleanup();
}

{
  const { agent, ledger, cleanup } = setup();
  ledger.addEntry({ customerName: 'Ramesh', amount: 500, type: 'credit', date: TODAY, note: 'seed' });

  const blocked = agent.handle('Ramesh ko reminder bhejo');
  eq(blocked.intent, 'reminder', 'Reminder request understood');
  eq(blocked.events[0].allowed, false, 'Reminder blocked without opt-in');
  eq(blocked.events[0].reason, 'not_opted_in', 'Refusal reason is opt-in');

  ledger.setReminderOptIn('Ramesh', true);
  const allowed = agent.handle('Ramesh ko reminder bhejo');
  eq(allowed.events[0].allowed, true, 'Reminder allowed after opt-in');
  ok(isCompliantSpeech(allowed.spoken), 'Reminder speech has no pressure language', allowed.spoken);
  cleanup();
}

{
  const { agent, cleanup } = setup();
  const samples = [
    'Ramesh ka 340 udhaar',
    'Suresh ne 200 diya',
    'Ramesh ka total?',
    'nahi 430',
    'kiski sabse zyada baaki hai',
    'Ramesh ko reminder bhejo',
  ];
  for (const sample of samples) {
    const r = agent.handle(sample);
    ok(isCompliantSpeech(r.spoken), `Compliant speech for "${sample}"`, r.spoken);
  }
  cleanup();
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n🧠 PARSER EDGE CASES\n');
// ─────────────────────────────────────────────────────────────────────────────

{
  const parsed = parseIntent('Ramesh ka 340 udhaar, kal 200 diya tha', { now: NOW });
  eq(parsed.entries.length, 2, 'Parser exposes both entries for inspection');
  eq(parsed.customer, 'Ramesh', 'Parser resolves the customer once');
}

{
  const parsed = parseIntent('Suresh se 500 jama hue', { now: NOW });
  eq(parsed.entries[0].type, 'payment', 'Parser maps "jama" to payment');
}

{
  const parsed = parseIntent('Aaj kitna udhaar gaya?', { now: NOW });
  eq(parsed.intent, 'query', 'Parser classifies a question');
  eq(parsed.query.kind, 'today_credit', 'Parser classifies a today-credit question');
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n' + '═'.repeat(52));
console.log(`📊 INTENT TESTS: ${passed}/${passed + failed} passed, ${failed} failed`);
console.log('═'.repeat(52));
if (failed > 0) process.exit(1);
console.log('🎉 Intent and number understanding verified.\n');
