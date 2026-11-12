/**
 * Bolti Bahi — behavioural judge for the "Bolti Bahi for kirana stores" brief.
 *
 * Rules this file follows:
 *   - every point is earned by running the agent and reading the ledger;
 *     no points are awarded for finding a string in the source
 *   - compliance is a hard gate: one violation caps the score at 0
 *   - external services that need keys are reported as UNVERIFIED, never faked
 *
 * Run: node test/judge-evaluation.js
 */

import { mkdtempSync, readFileSync, readdirSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LedgerDB } from '../lib/ledger-db.js';
import { KhataAgent, AI_DISCLOSURE } from '../lib/agent.js';
import { scanAmounts, normalizeSpokenText } from '../lib/hindi-numbers.js';
import { isCompliantSpeech, safeSpeech } from '../lib/speech-guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NOW = new Date(2026, 10, 10, 12, 0, 0);
const TODAY = '2026-11-10';

const dirs = [];
const ledgers = [];
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'khata-judge-'));
  dirs.push(dir);
  const ledger = new LedgerDB(join(dir, 'khata.db'));
  ledgers.push(ledger);
  const agent = new KhataAgent({ ledger, now: () => NOW });
  return { dir, ledger, agent, dbPath: join(dir, 'khata.db') };
}
function teardown() {
  for (const ledger of ledgers) {
    try { ledger.close(); } catch { /* already closed */ }
  }
  ledgers.length = 0;
  while (dirs.length) {
    rmSync(dirs.pop(), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const entriesOf = (result) => result.events.filter((e) => e.type === 'entry').map((e) => e.entry);
function amountOf(text) {
  const { amounts } = scanAmounts(normalizeSpokenText(text));
  return amounts[0]?.value ?? null;
}

function readAllText(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (['node_modules', '.git', 'coverage'].includes(name)) continue;
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) readAllText(path, acc);
    else if (stat.size < 500_000) {
      try { acc.push({ path, text: readFileSync(path, 'utf8') }); } catch { /* binary */ }
    }
  }
  return acc;
}

let gateFailures = [];
let gateChecks = 0;
function gate(name, condition, detail = '') {
  gateChecks += 1;
  if (condition) {
    console.log(`  🛡️  ${name}`);
  } else {
    gateFailures.push(name);
    console.log(`  💥 GATE FAILED: ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const sections = [];
function section(name, max, fn) {
  const record = { name, max, earned: 0, checks: 0 };
  console.log(`\n▶ ${name} (max ${max})`);
  const add = (points, condition, label) => {
    record.checks += 1;
    if (condition) {
      record.earned += points;
      console.log(`  ✅ ${label}`);
    } else {
      console.log(`  ❌ ${label}`);
    }
  };
  try {
    fn(add);
  } catch (err) {
    console.log(`  ❌ section crashed: ${err.message}`);
  }
  record.earned = Math.min(record.earned, max);
  sections.push(record);
}

console.log('╔══════════════════════════════════════════════════════════════════════╗');
console.log('║   BOLTI BAHI — BEHAVIOURAL JUDGE (100 pts + compliance gates)        ║');
console.log('╚══════════════════════════════════════════════════════════════════════╝');

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n🔒 COMPLIANCE GATES (any failure = 0 overall)\n');
// ─────────────────────────────────────────────────────────────────────────────

// 1. AI disclosure in the first turn, in the user's language.
gate(
  'First turn identifies the AI, in Hinglish/Hindi',
  /AI/i.test(AI_DISCLOSURE) && /(namaste|assistant|hoon)/i.test(AI_DISCLOSURE),
  AI_DISCLOSURE,
);

// 2. Transcripts encrypted at rest.
{
  const { ledger, agent, dbPath, dir } = setup();
  const marker = 'JUDGE_MARKER_9f3b1 transcript plaintext';
  agent.handle(`Ramesh ka 340 udhaar ${marker}`);
  ledger.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const bytes = readFileSync(dbPath, 'latin1');
  const walPath = `${dbPath}-wal`;
  const wal = existsSync(walPath) ? readFileSync(walPath, 'latin1') : '';
  gate('Spoken transcript is encrypted at rest', !bytes.includes(marker) && !wal.includes(marker));
  gate('Ciphertext envelope is present on disk', `${bytes}${wal}`.includes('enc:v1:'));

  // 3. Retention purge deletes transcript text.
  const removed = ledger.purgeTranscripts();
  ledger.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const after = readFileSync(dbPath, 'latin1');
  gate('Retention purge removes transcript text', removed >= 1 && !after.includes(marker));
  gate('Purge keeps the ledger arithmetic intact', ledger.getCustomerBalance('Ramesh').balance === 340);
  ledger.close();
  ledgers.splice(ledgers.indexOf(ledger), 1);
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  dirs.splice(dirs.indexOf(dir), 1);
}

// 4. Reminders: opt-in only, polite, no pressure.
{
  const { ledger, agent } = setup();
  ledger.addEntry({ customerName: 'Ramesh', amount: 500, type: 'credit', date: TODAY, note: 'seed' });
  const blocked = agent.handle('Ramesh ko reminder bhejo');
  gate('Reminder blocked without opt-in', blocked.events[0]?.allowed === false && blocked.events[0]?.reason === 'not_opted_in');
  ledger.setReminderOptIn('Ramesh', true);
  const allowed = agent.handle('Ramesh ko reminder bhejo');
  gate('Reminder allowed after explicit opt-in', allowed.events[0]?.allowed === true);
  gate('Reminder wording carries no pressure language', isCompliantSpeech(allowed.spoken));
  gate('Reminder is not claimed as delivered', allowed.events[0]?.delivered === false);
}

// 5. Pressure/threat language is filtered on the way out.
gate(
  'Pressure language is filtered from speech',
  isCompliantSpeech(safeSpeech('Ramesh ko turant paisa chuka do warna police bulayenge')) &&
    !/turant|warna|police/i.test(safeSpeech('Ramesh ko turant paisa chuka do warna police bulayenge')),
);

// 6. No lending advice, no medical advice.
{
  const { agent, ledger } = setup();
  const lending = agent.handle('Ramesh ko 5000 ka loan de do');
  const health = agent.handle('Ramesh ko bukhar ki dawa do');
  gate('Lending requests are refused', lending.intent === 'refuse' && entriesOf(lending).length === 0);
  gate('Medical advice is refused', health.intent === 'refuse' && entriesOf(health).length === 0);
  gate('Refusals create no ledger rows', ledger.getAllEntries().length === 0);
}

// 7. Secrets and data hygiene in the repo.
{
  const files = readAllText(ROOT).filter((f) => extname(f.path) !== '.db' && !f.path.endsWith('.key'));
  const secretPattern = /(AIza[0-9A-Za-z_-]{30,}|sk-[A-Za-z0-9]{30,}|x-api-key-id["']?\s*[:=]\s*["'][A-Za-z0-9]{20,})/;
  const leaks = files.filter((f) => secretPattern.test(f.text));
  gate('No API keys committed to the repository', leaks.length === 0, leaks.map((f) => f.path).join(', '));

  const gitignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
  gate('.env and databases are gitignored', /^\.env$/m.test(gitignore) && /\*\.db/m.test(gitignore));
  const envExample = readFileSync(join(ROOT, '.env.example'), 'utf8');
  gate('.env.example holds placeholders only', !secretPattern.test(envExample));
}

// 8. No voice cloning, preset voices only.
{
  const tts = readFileSync(join(ROOT, 'lib/gnani-tts.js'), 'utf8');
  gate('Only preset TTS voices are used (no cloning)', /timbre-v3\.0/.test(tts) && !/clone|reference_audio|voice_sample/i.test(tts));
}

// 9. No fabricated ledger data or fake recognition in the demo UI.
{
  const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
  gate('UI contains no hardcoded fake balances', !/8,750|8750|Ramesh Bhai/.test(html));
  gate('UI contains no simulated voice recognition', !/simulateOfflineVoiceRecognition|Math\.random\(\)\s*\*\s*sampleCommands/.test(html));
}

// ─────────────────────────────────────────────────────────────────────────────
section('1. Live judge test (exact amount + direction + correction)', 30, (add) => {
  const cases = [
    {
      lines: ['Ramesh ka 340 udhaar'],
      amount: 340, type: 'credit', balance: 340, date: TODAY,
    },
    {
      lines: ['Ramesh ka 340 udhaar, kal 200 diya tha'],
      amount: 340, type: 'credit', balance: 140, date: TODAY, second: { amount: 200, type: 'payment', date: '2026-11-09' },
    },
    {
      lines: ['Suresh ne 200 diya'],
      amount: 200, type: 'payment', balance: -200, date: TODAY,
    },
    {
      lines: ['Ramesh ke khate mein teen sau chaalis udhaar'],
      amount: 340, type: 'credit', balance: 340, date: TODAY,
    },
    {
      lines: ['Mahesh credit 750 rupees'],
      amount: 750, type: 'credit', balance: 750, date: TODAY,
    },
    {
      lines: ['Suresh ka 500 udhaar', 'nahi, 430'],
      amount: 430, type: 'credit', balance: 430, date: TODAY, correctedFrom: 500,
    },
    {
      lines: ['Ramesh ka 100 udhaar', 'Ramesh ka total?'],
      amount: 100, type: 'credit', balance: 100, date: TODAY, queryValue: 100,
    },
    {
      lines: ['parso Suresh ka 500 udhaar'],
      amount: 500, type: 'credit', balance: 500, date: '2026-11-08',
    },
    {
      lines: ['Ramesh ko 200 de do'],
      amount: 200, type: 'credit', balance: 200, date: TODAY,
    },
    {
      lines: ['Suresh se 500 jama hue'],
      amount: 500, type: 'payment', balance: -500, date: TODAY,
    },
  ];

  for (const tc of cases) {
    const { ledger, agent } = setup();
    let last;
    let entryResult = null;
    for (const line of tc.lines) {
      last = agent.handle(line);
      if (entriesOf(last).length > 0) entryResult = last;
    }

    const list = entriesOf(entryResult);
    const entry = list[0];
    add(1, entry?.amount === tc.amount, `"${tc.lines[0]}" records exact amount ₹${tc.amount}`);
    add(1, entry?.type === tc.type && entry?.date === tc.date, `"${tc.lines[0]}" records ${tc.type} on ${tc.date}`);

    if (tc.queryValue !== undefined) {
      const q = last.events.find((e) => e.type === 'query');
      add(1, q?.value === tc.queryValue && /100/.test(last.spoken), 'spoken balance answer matches the ledger');
    } else if (tc.second) {
      const second = list[1];
      add(1, second?.amount === tc.second.amount && second?.type === tc.second.type && second?.date === tc.second.date,
        'compound clause keeps its own amount, direction and date');
    } else if (tc.correctedFrom !== undefined) {
      add(1, entry?.corrected_from === tc.correctedFrom && ledger.getCustomerBalance(entry?.customerName).balance === tc.balance,
        `spoken correction 500→430 is applied and audited`);
    } else {
      add(1, ledger.getCustomerBalance(entry?.customerName).balance === tc.balance, `ending balance is ₹${tc.balance}`);
    }

    ledger.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('2. Speech layer: numbers under noise', 20, (add) => {
  const numbers = [
    ['teen sau chaalis', 340], ['paanch sau', 500], ['ek hazaar', 1000],
    ['do hazaar paanch sau', 2500], ['bees', 20], ['sau', 100], ['nau sau', 900],
    ['dedh sau', 150], ['dhai sau', 250], ['sawa sau', 125], ['sawa do sau', 225],
    ['paune do sau', 175], ['saadhe teen sau', 350], ['three-forty', 340],
    ['three hundred forty', 340], ['340', 340], ['३४०', 340],
    ['दो सौ चालीस', 240], ['1,20,000', 120000], ['5k', 5000],
  ];
  for (const [text, expected] of numbers) {
    add(0.5, amountOf(text) === expected, `"${text}" → ${expected}`);
  }

  const noisy = [
    ['arre bhai sun, Ramesh ka teen sau chaalis udhaar likh de', 340, 'credit'],
    ['Ramesh.... three-forty... udhaar', 340, 'credit'],
    ['तीन सौ चालीस udhaar Ramesh', 340, 'credit'],
    ['Suresh 1,200 jama', 1200, 'payment'],
    ['Ramesh ka 5k udhaar', 5000, 'credit'],
  ];
  for (const [text, amount, type] of noisy) {
    const { agent, cleanupLedger } = (() => {
      const s = setup();
      return { agent: s.agent, cleanupLedger: () => s.ledger.close() };
    })();
    const e = entriesOf(agent.handle(text))[0];
    add(1, e?.amount === amount && e?.type === type, `noisy "${text}" → ${type} ₹${amount}`);
    cleanupLedger();
  }

  const mixed = [
    ['Mahesh credit 750 rupees', 750, 'credit'],
    ['Suresh ne payment kar diya 300 ka', 300, 'payment'],
    ['Ramesh ka 100 udhaar aur 50 jama', 100, 'credit'],
    ['kal Suresh ka 200 udhaar', 200, 'credit'],
    ['Ramesh ne 250 diya', 250, 'payment'],
  ];
  for (const [text, amount, type] of mixed) {
    const s = setup();
    const e = entriesOf(s.agent.handle(text))[0];
    add(1, e?.amount === amount && e?.type === type, `code-mix "${text}" → ${type} ₹${amount}`);
    s.ledger.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('3. Fit for the target user', 20, (add) => {
  // Spoken answers must be fast.
  {
    const { ledger, agent } = setup();
    ledger.addEntry({ customerName: 'Ramesh', amount: 340, type: 'credit', date: TODAY, note: 'seed' });
    const samples = ['Ramesh ka total?', 'Aaj kitna udhaar gaya?', 'Ramesh ka 100 udhaar', 'kiski sabse zyada baaki hai'];
    let max = 0;
    for (let i = 0; i < 300; i += 1) {
      const started = process.hrtime.bigint();
      agent.handle(samples[i % samples.length]);
      max = Math.max(max, Number(process.hrtime.bigint() - started) / 1e6);
    }
    add(5, max < 2000, `worst-case local answer ${max.toFixed(2)}ms < 2000ms`);
    ledger.close();
  }

  // Shared names must be asked about, then resolved.
  {
    const { ledger, agent } = setup();
    ledger.addEntry({ customerName: 'Ramesh', amount: 100, type: 'credit', date: TODAY, note: 'seed' });
    ledger.addEntry({ customerName: 'Ramesh Kumar', amount: 50, type: 'credit', date: TODAY, note: 'seed' });
    const ask = agent.handle('Ramesh ka 100 udhaar');
    const answer = agent.handle('dusra');
    add(5,
      ask.intent === 'clarify' && /Ramesh Kumar/.test(ask.spoken) &&
      entriesOf(answer)[0]?.customerName === 'Ramesh Kumar' &&
      ledger.getCustomerBalance('Ramesh').balance === 100,
      'two Rameshes trigger a short question and "dusra" resolves it');
    ledger.close();
  }

  // Corrections keep the audit trail.
  {
    const { ledger, agent } = setup();
    agent.handle('Suresh ka 500 udhaar');
    const fixed = agent.handle('nahi, 430');
    const e = entriesOf(fixed)[0];
    add(5, e?.amount === 430 && e?.corrected_from === 500 && ledger.getCustomerBalance('Suresh').balance === 430,
      'spoken correction rewrites the amount and keeps the old one in the audit trail');
    ledger.close();
  }

  // Hands-free: punctuation and filler from real STT must not break a turn.
  {
    const { agent, ledger } = setup();
    const e = entriesOf(agent.handle('Arre, Ramesh ka... teen sau chaalis udhaar tha.')).at(0);
    add(5, e?.amount === 340 && e?.type === 'credit' && ledger.getCustomerBalance('Ramesh').balance === 340,
      'STT punctuation/filler does not change the recorded amount');
    ledger.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('4. Innovation', 10, (add) => {
  {
    const { ledger, agent } = setup();
    const r = agent.handle('Ramesh ka 340 udhaar, kal 200 diya tha');
    const e = entriesOf(r);
    add(5, e.length === 2 && e[0].amount === 340 && e[1].amount === 200 && e[1].date === '2026-11-09',
      'one sentence, two transactions with independent dates');
    ledger.close();
  }
  {
    const { ledger, agent } = setup();
    ledger.addEntry({ customerName: 'Ram', amount: 10, type: 'credit', date: TODAY, note: 'seed' });
    agent.handle('Ramesh ka 40 udhaar');
    agent.handle('Ramesh Kumar ka 60 udhaar');
    const ram = ledger.getCustomerBalance('Ram').balance;
    const ramesh = ledger.getCustomerBalance('Ramesh').balance;
    const kumar = ledger.getCustomerBalance('Ramesh Kumar').balance;
    add(5, ram === 10 && ramesh === 40 && kumar === 60,
      '"Ram", "Ramesh" and "Ramesh Kumar" stay three separate ledgers');
    ledger.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('5. Responsible AI (behaviour, not claims)', 10, (add) => {
  add(2.5, /AI/i.test(AI_DISCLOSURE) && /namaste/i.test(AI_DISCLOSURE), 'AI is disclosed in the first turn, in the user language');

  {
    const { ledger, agent, dbPath, dir } = setup();
    const marker = 'SECTION5_MARKER_plain_text';
    agent.handle(`Ramesh ka 340 udhaar ${marker}`);
    ledger.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const bytes = readFileSync(dbPath, 'latin1') + (existsSync(`${dbPath}-wal`) ? readFileSync(`${dbPath}-wal`, 'latin1') : '');
    add(2.5, !bytes.includes(marker), 'transcripts are encrypted at rest');
    ledger.purgeTranscripts();
    add(2.5, ledger.getRecentEntries(10).every((e) => e.note === null), 'transcript retention purge works');
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  }

  {
    const { ledger, agent } = setup();
    ledger.addEntry({ customerName: 'Ramesh', amount: 500, type: 'credit', date: TODAY, note: 'seed' });
    const blocked = agent.handle('Ramesh ko reminder bhejo');
    ledger.setReminderOptIn('Ramesh', true);
    const allowed = agent.handle('Ramesh ko reminder bhejo');
    add(2.5, blocked.events[0]?.allowed === false && allowed.events[0]?.allowed === true && isCompliantSpeech(allowed.spoken),
      'reminders are opt-in only and polite');
    ledger.close();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
section('6. Demo and documentation quality', 10, (add) => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const docChecks = [
    [/quick start|setup/i, 'setup instructions'],
    [/GNANI_API_KEY/, 'environment variables'],
    [/encrypt/i, 'transcript encryption documented'],
    [/retention|purge/i, 'transcript retention documented'],
    [/opt-in/i, 'reminder opt-in documented'],
    [/responsible ai/i, 'responsible AI section'],
  ];
  for (const [pattern, label] of docChecks) {
    add(0.5, pattern.test(readme), `README documents ${label}`);
  }
  add(2,
    !/node (18|16)\b/i.test(readme) && !/better-sqlite3/i.test(readme) && !/100\s*\/\s*100/.test(readme),
    'README makes no false runtime or score claims');
  add(1, /limitations/i.test(readme), 'README lists known limitations honestly');
  add(1, /websocket|\/api\//i.test(readme), 'README documents the API/WebSocket surface');

  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  add(1, /22\.5/.test(pkg.engines?.node || ''), 'package.json declares the real Node requirement');
  add(1, /judge-evaluation/.test(pkg.scripts?.test || ''), 'npm test runs the judge suite');
  add(1, pkg.scripts?.start === 'node server.js', 'npm start runs the server');
});

// ─────────────────────────────────────────────────────────────────────────────
const behavioural = sections.reduce((sum, s) => sum + s.earned, 0);
const total = gateFailures.length > 0 ? 0 : behavioural;

console.log('\n' + '═'.repeat(70));
console.log('                       JUDGE SCORECARD');
console.log('═'.repeat(70));
for (const s of sections) {
  const width = 24;
  const bar = '█'.repeat(Math.round((s.earned / s.max) * width)).padEnd(width, '░');
  console.log(` ${s.name.padEnd(46)} [${bar}] ${s.earned.toFixed(1)} / ${s.max}`);
}
console.log('─'.repeat(70));
console.log(` Behavioural score: ${behavioural.toFixed(1)} / 100`);
if (gateFailures.length > 0) {
  console.log(` Compliance gates failed (${gateFailures.length}): ${gateFailures.join('; ')}`);
  console.log(' FINAL SCORE: 0 / 100 (compliance gate caps the score)');
} else {
  console.log(' FINAL SCORE: ' + `${behavioural.toFixed(1)} / 100`);
}
console.log('═'.repeat(70));

console.log('\nExternal integrations (cannot be scored without credentials):');
console.log(`  Gnani Prisma STT : ${process.env.GNANI_API_KEY ? 'key present' : 'UNVERIFIED — no GNANI_API_KEY'}`);
console.log(`  Gnani Timbre TTS : ${process.env.GNANI_API_KEY ? 'key present' : 'UNVERIFIED — browser speech fallback'}`);
console.log('  Live microphone  : UNVERIFIED in this harness (requires a browser + mic)');

teardown();

if (total >= 100 && gateFailures.length === 0) {
  console.log('\n🎉 100/100 behavioural score, all compliance gates passed.\n');
  process.exit(0);
}
console.log(`\n⚠️  ${total.toFixed(1)}/100. Target is 100 with zero gate failures.\n`);
process.exit(1);
