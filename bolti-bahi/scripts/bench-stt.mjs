/**
 * Speech-recognition accuracy benchmark: Timbre TTS -> PCM -> Prisma STT -> parser.
 *
 * Measures the part that a live mic demo is judged on: did the ASR produce a
 * transcript whose amount and direction are correct? Reports per-utterance
 * results, ASR latency and aggregate accuracy. Exits non-zero if any case fails.
 *
 *   npm run bench:stt
 *
 * The key is read from GNANI_API_KEY only, never printed or stored. Without it
 * the benchmark skips and exits 0.
 */

import 'dotenv/config';
import { GnaniTTS } from '../lib/gnani-tts.js';
import { GnaniSTT } from '../lib/gnani-stt.js';
import { PcmFramer } from '../lib/pcm-framer.js';
import { parseIntent } from '../lib/intent-parser.js';

const apiKey = process.env.GNANI_API_KEY;
const SAMPLE_RATE = 16000;

const CASES = [
  { say: 'Ramesh ka teen sau chaalis udhaar', amount: 340, type: 'credit', customer: 'Ramesh' },
  { say: 'Suresh ne do sau rupay diye', amount: 200, type: 'payment', customer: 'Suresh' },
  { say: 'Mahesh ka paanch sau udhaar', amount: 500, type: 'credit', customer: 'Mahesh' },
  { say: 'Dinesh ka dedh sau udhaar', amount: 150, type: 'credit', customer: 'Dinesh' },
  { say: 'Suresh se ek hazaar do sau jama hue', amount: 1200, type: 'payment', customer: 'Suresh' },
  {
    say: 'Ramesh ka teen sau chaalis udhaar, kal do sau diya tha',
    amount: 340,
    type: 'credit',
    customer: 'Ramesh',
    second: { amount: 200, type: 'payment' },
  },
];

if (!apiKey) {
  console.log('\n⏭️  SKIPPED: GNANI_API_KEY is not set, so live ASR accuracy cannot be measured.');
  console.log('   Add it under Settings → Secrets (Cloud) or an untracked .env (local),');
  console.log('   then run: npm run bench:stt\n');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function transcribe(tts, text) {
  const chunks = await tts.synthesize(text, {
    voice: 'Shivani',
    model: 'timbre-v3.0',
    language: 'hi-IN',
    speed: 1.0,
    sampleRate: SAMPLE_RATE,
    container: 'raw',
  });
  const pcm = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.audio, 'base64')));
  if (pcm.length === 0) throw new Error('TTS returned no audio');

  const stt = new GnaniSTT(apiKey);
  const ws = await stt.connect({
    model: 'prisma-v3.0',
    languageCode: 'hi-IN,en-IN',
    format: 'codemix',
    sampleRate: SAMPLE_RATE,
  });

  const finals = [];
  let latency = null;
  let serviceError = null;

  const finished = new Promise((resolve) => {
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'transcript' && msg.text && msg.is_final !== false) {
        finals.push(msg.text.trim());
        if (typeof msg.latency === 'number') latency = msg.latency;
        resolve();
      } else if (msg.type === 'error') {
        serviceError = msg.message || 'unknown STT error';
        resolve();
      }
    });
  });

  const framer = new PcmFramer({ send: (frame) => ws.send(frame) });
  framer.start();
  const hundredMs = Math.round((SAMPLE_RATE * 2 * 100) / 1000);
  for (let offset = 0; offset < pcm.length; offset += hundredMs) {
    framer.push(pcm.subarray(offset, offset + hundredMs));
    await sleep(100);
  }
  framer.stop();
  framer.flush();
  GnaniSTT.commit(ws);

  await Promise.race([finished, sleep(10000)]);
  try { ws.close(); } catch { /* noop */ }

  if (serviceError) throw new Error(serviceError);
  return { transcript: finals.join(' ').trim(), latency };
}

const tts = new GnaniTTS(apiKey);
const rows = [];

console.log('\n🎙️  Bolti Bahi — speech recognition accuracy\n');
console.log('  Utterance → transcript → parsed ledger\n');

for (const testCase of CASES) {
  const started = Date.now();
  let transcript = '';
  let error = null;
  let latency = null;

  try {
    const result = await transcribe(tts, testCase.say);
    transcript = result.transcript;
    latency = result.latency;
  } catch (err) {
    error = err.message;
  }

  const parsed = transcript ? parseIntent(transcript, { now: new Date() }) : { entries: [] };
  const entries = parsed.entries || [];
  const first = entries[0];

  const amountOk = first?.amount === testCase.amount;
  const directionOk = first?.type === testCase.type;
  const customerOk = !testCase.customer || (parsed.customer || '').toLowerCase().includes(testCase.customer.toLowerCase());
  const secondOk = !testCase.second || entries.some(
    (entry) => entry.amount === testCase.second.amount && entry.type === testCase.second.type,
  );
  const pass = Boolean(transcript) && amountOk && directionOk && customerOk && secondOk;

  rows.push({
    said: testCase.say,
    heard: transcript,
    expected: `${testCase.type} ₹${testCase.amount}`,
    got: first ? `${first.type} ₹${first.amount}` : '—',
    exactAmount: amountOk,
    direction: directionOk,
    customer: customerOk,
    secondClause: secondOk,
    latencyMs: latency,
    wallMs: Date.now() - started,
    pass,
    error,
  });

  const icon = pass ? '✅' : '❌';
  console.log(`${icon} "${testCase.say}"`);
  console.log(`   heard: "${transcript || '(nothing)'}"`);
  console.log(`   parsed: ${first ? `${first.type} ₹${first.amount} for ${parsed.customer || '?'}` : `no entry${error ? ` (${error})` : ''}`}`);
  console.log(`   expected: ${testCase.type} ₹${testCase.amount}${testCase.second ? ` + ${testCase.second.type} ₹${testCase.second.amount}` : ''}`);
  console.log('');
}

const total = rows.length;
const passedCount = rows.filter((row) => row.pass).length;
const amountAccuracy = Math.round((rows.filter((row) => row.exactAmount).length / total) * 1000) / 10;
const directionAccuracy = Math.round((rows.filter((row) => row.direction).length / total) * 1000) / 10;
const latencies = rows.map((row) => row.latencyMs).filter((value) => typeof value === 'number');

console.log('────────────────────────────────────────────────────────');
console.log(` Cases:                ${passedCount}/${total}`);
console.log(` Exact amount:         ${amountAccuracy}%`);
console.log(` Correct direction:    ${directionAccuracy}%`);
if (latencies.length > 0) {
  console.log(` Mean ASR latency:     ${Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)} ms`);
  console.log(` Max ASR latency:      ${Math.max(...latencies)} ms`);
}
console.log('────────────────────────────────────────────────────────');
console.log(' Note: this harness uses synthesized speech, so it measures the ASR +');
console.log(' parser path, not real shop-noise microphone quality.\n');

if (passedCount !== total) {
  console.error(`❌ ${total - passedCount} utterance(s) failed the exact-amount/direction check.\n`);
  process.exit(1);
}

console.log('🎉 Recognition accuracy verified on all cases.\n');
