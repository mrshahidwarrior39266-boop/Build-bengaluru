/**
 * Live Gnani verification: TTS -> PCM -> Prisma STT -> ledger intent.
 *
 * This is the only script that touches the real Gnani service. It never prints,
 * logs or stores the API key; it only reads GNANI_API_KEY from the environment
 * (or an untracked .env). Run it locally or in the judge environment:
 *
 *   GNANI_API_KEY=... npm run verify:gnani
 *
 * Exit codes: 0 = verified or skipped (no key), 1 = verification failed.
 */

import 'dotenv/config';
import { GnaniTTS } from '../lib/gnani-tts.js';
import { GnaniSTT } from '../lib/gnani-stt.js';
import { PcmFramer } from '../lib/pcm-framer.js';
import { parseIntent } from '../lib/intent-parser.js';

const SENTENCE = 'Ramesh ka teen sau chaalis udhaar';
const EXPECTED_AMOUNT = 340;
const SAMPLE_RATE = 16000;

const apiKey = process.env.GNANI_API_KEY;

if (!apiKey) {
  console.log('\n⏭️  SKIPPED: GNANI_API_KEY is not set.');
  console.log('   Add it under Settings → Secrets (Cloud) or in an untracked .env (local),');
  console.log('   then re-run: npm run verify:gnani\n');
  process.exit(0);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let sttSocket = null;

try {
  console.log('\n🎙️  Gnani verification\n');

  // 1. Timbre -> raw 16 kHz PCM.
  const tts = new GnaniTTS(apiKey);
  const startedTts = Date.now();
  const chunks = await tts.synthesize(SENTENCE, {
    voice: 'Shivani',
    model: 'timbre-v3.0',
    language: 'hi-IN',
    speed: 1.0,
    sampleRate: SAMPLE_RATE,
    container: 'raw',
  });
  const pcm = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.audio, 'base64')));
  if (pcm.length === 0) throw new Error('Timbre returned no audio');

  const audioMs = Math.round((pcm.length / 2 / SAMPLE_RATE) * 1000);
  console.log(`✅ Timbre v3.0: ${chunks.length} chunks, ${pcm.length} bytes (~${audioMs} ms), ${Date.now() - startedTts} ms wall`);

  // 2. Prisma streaming STT, fed the synthesized audio in real time.
  const stt = new GnaniSTT(apiKey);
  sttSocket = await stt.connect({
    model: 'prisma-v3.0',
    languageCode: 'hi-IN,en-IN',
    format: 'codemix',
    sampleRate: SAMPLE_RATE,
  });

  const transcripts = [];
  const errors = [];
  sttSocket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === 'transcript' && msg.text) {
      transcripts.push({ text: msg.text, language: msg.detected_language_code, latency: msg.latency });
      console.log(`✅ Prisma transcript: "${msg.text}" (${msg.detected_language_code || 'n/a'}, ${msg.latency}ms)`);
    } else if (msg.type === 'error') {
      errors.push(msg.message);
      console.error(`❌ Prisma error: ${msg.message}`);
    }
  });

  const framer = new PcmFramer({ send: (frame) => sttSocket.send(frame) });
  framer.start();
  const chunkBytes = (SAMPLE_RATE * 2 * 100) / 1000; // 100 ms of audio
  for (let offset = 0; offset < pcm.length; offset += chunkBytes) {
    framer.push(pcm.subarray(offset, offset + chunkBytes));
    await sleep(100);
  }
  framer.stop();
  framer.flush();
  GnaniSTT.commit(sttSocket);

  const deadline = Date.now() + 12000;
  while (transcripts.length === 0 && Date.now() < deadline) await sleep(200);

  if (transcripts.length === 0) {
    throw new Error(`Prisma returned no transcript${errors.length ? `: ${errors.join('; ')}` : ''}`);
  }

  // 3. The transcript must produce the right ledger entry.
  const parsed = transcripts
    .map((t) => parseIntent(t.text, { now: new Date() }))
    .find((p) => p.entries?.some((e) => e.amount === EXPECTED_AMOUNT));

  const firstEntry = parsed?.entries?.[0];
  if (!firstEntry || firstEntry.amount !== EXPECTED_AMOUNT) {
    const got = transcripts.map((t) => t.text).join(' | ');
    throw new Error(`STT did not yield ₹${EXPECTED_AMOUNT}: "${got}"`);
  }

  console.log(`✅ Ledger intent: ${firstEntry.type} ₹${firstEntry.amount} for "${parsed.customer}"`);
  console.log('\n🎉 Speech layer verified end to end (TTS → PCM → Prisma → ledger).');
  console.log('   Note: this proves the adapter contract against the live service;');
  console.log('   microphone/noise quality still needs a live demo check.\n');
  process.exit(0);
} catch (err) {
  // Never echo anything that could contain the key.
  console.error(`\n❌ Gnani verification failed: ${err.message}\n`);
  process.exit(1);
} finally {
  if (sttSocket) {
    try { sttSocket.close(); } catch { /* noop */ }
  }
}
