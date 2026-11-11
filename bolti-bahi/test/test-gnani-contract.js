/**
 * Offline contract tests for the Gnani adapters and the PCM framer.
 *
 * These run two local `ws` servers that speak the documented wire protocol, so
 * they prove our request shape, headers and response parsing without a key, a
 * microphone or any network access. Live service behaviour is checked
 * separately with `npm run verify:gnani`.
 */

import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { GnaniSTT } from '../lib/gnani-stt.js';
import { GnaniTTS } from '../lib/gnani-tts.js';
import { PcmFramer, STT_FRAME_BYTES } from '../lib/pcm-framer.js';

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

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function listen(wss) {
  await once(wss, 'listening');
  return wss.address().port;
}

async function waitFor(predicate, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 1. PCM framing
// ---------------------------------------------------------------------------
console.log('\nPCM framer (Prisma needs exactly 1024 bytes per frame)');

{
  const sent = [];
  const drops = [];
  const framer = new PcmFramer({
    send: (frame) => sent.push(frame),
    onDrop: (bytes) => drops.push(bytes),
  });

  const input = Buffer.alloc(2500, 7);
  framer.push(input);
  eq('buffers until paced', sent.length, 0);
  eq('carries the partial frame', framer.bufferedBytes, 2500);

  framer.flush();
  eq('emits whole frames on flush', sent.length, 3);
  check('every frame is exactly 1024 bytes', sent.every((f) => f.length === STT_FRAME_BYTES));
  check('frame bytes match the captured audio', Buffer.concat(sent).subarray(0, 2500).equals(input));
  check('final frame is zero-padded', sent[2].subarray(452).every((b) => b === 0));

  const small = new PcmFramer({ send: () => {} });
  small.push(Buffer.alloc(512, 1));
  small.push(Buffer.alloc(512, 2));
  eq('joins two browser chunks into one frame', small.bufferedBytes, 1024);

  const backlogged = new PcmFramer({ send: () => {}, maxQueueBytes: 2048, onDrop: (b) => drops.push(b) });
  backlogged.push(Buffer.alloc(1024 * 8, 3));
  check('drops stale audio when the browser outruns the pace', drops.reduce((a, b) => a + b, 0) > 0);
  eq('backlog stays bounded', backlogged.queuedBytes <= 2048, true);
}

// ---------------------------------------------------------------------------
// 2. Prisma STT contract
// ---------------------------------------------------------------------------
console.log('\nPrisma v3.0 STT wire contract');

{
  const wss = new WebSocketServer({ port: 0 });
  const port = await listen(wss);

  let upgradeHeaders = null;
  const binaryFrames = [];
  const controlFrames = [];
  let connection = null;

  wss.on('connection', (ws, req) => {
    connection = ws;
    upgradeHeaders = req.headers;
    ws.send(JSON.stringify({ type: 'connected', config: { model: 'prisma-v3.0' } }));
    ws.send(JSON.stringify({ type: 'speech_start' }));

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        binaryFrames.push(data.length);
        if (binaryFrames.length === 2) {
          ws.send(JSON.stringify({
            type: 'transcript',
            text: 'Ramesh ka 340 udhaar',
            is_final: false,
            detected_language_code: 'hi-IN',
          }));
          ws.send(JSON.stringify({
            type: 'transcript',
            text: 'Ramesh ka teen sau chaalis udhaar',
            is_final: true,
            detected_language_code: 'hi-IN',
          }));
        }
        return;
      }
      controlFrames.push(JSON.parse(data.toString()));
    });
  });

  const stt = new GnaniSTT('unit-test-key', { url: `ws://127.0.0.1:${port}/stt/v3/stream` });
  const ws = await stt.connect({ languageCode: 'hi-IN,en-IN', format: 'codemix', sampleRate: 16000 });

  check('sends the key only in the x-api-key-id header', upgradeHeaders['x-api-key-id'] === 'unit-test-key');
  // Streaming takes exactly one locale; a comma list must collapse to the first
  // code, otherwise Gnani closes the socket with "exactly one locale is required".
  eq('language_code collapses a list to one locale', upgradeHeaders.language_code, 'hi-IN');
  eq('model header', upgradeHeaders.model, 'prisma-v3.0');
  eq('format header', upgradeHeaders.format, 'codemix');
  eq('x-sample-rate header', upgradeHeaders['x-sample-rate'], '16000');
  check('no legacy lang_code header', upgradeHeaders.lang_code === undefined);
  check('no legacy x-model header', upgradeHeaders['x-model'] === undefined);

  let keyterms = [];
  try { keyterms = JSON.parse(upgradeHeaders.keyterms); } catch { /* leave empty */ }
  check('keyterms is a JSON array', Array.isArray(keyterms) && keyterms.length > 0);
  check('keyterms include shop vocabulary', keyterms.includes('udhaar'));

  const events = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'transcript') events.push(msg);
  });

  for (let i = 0; i < 3; i += 1) ws.send(Buffer.alloc(STT_FRAME_BYTES, 1));
  check('client transmits raw 1024-byte frames', binaryFrames.every((len) => len === STT_FRAME_BYTES));

  const gotBoth = await waitFor(() => events.length === 2);
  check('receives partial then final transcript', gotBoth, `got ${events.length}`);
  eq('final text is parsed correctly', events[1]?.text, 'Ramesh ka teen sau chaalis udhaar');
  eq('is_final is preserved', events[1]?.is_final, true);
  eq('detected language is preserved', events[1]?.detected_language_code, 'hi-IN');

  GnaniSTT.commit(ws);
  check('commit control frame is sent on stop', await waitFor(() => controlFrames.some((m) => m.type === 'commit')));

  ws.close();
  connection?.close();
  wss.close();
}

// ---------------------------------------------------------------------------
// 3. Timbre TTS contract
// ---------------------------------------------------------------------------
console.log('\nTimbre v3.0 TTS wire contract');

{
  const wss = new WebSocketServer({ port: 0 });
  const port = await listen(wss);

  let upgradeHeaders = null;
  let request = null;
  const pcmA = Buffer.from([1, 2, 3, 4, 5, 6]);
  const pcmB = Buffer.from([7, 8, 9, 10]);

  wss.on('connection', (ws, req) => {
    upgradeHeaders = req.headers;
    ws.send(JSON.stringify({ type: 'start' }));

    ws.on('message', (raw) => {
      request = JSON.parse(raw.toString());
      ws.send(JSON.stringify({ type: 'audio', data: { chunk_index: 0, audio: pcmA.toString('base64'), is_final: false } }));
      ws.send(JSON.stringify({ type: 'audio', data: { chunk_index: 1, audio: pcmB.toString('base64'), is_final: true } }));
      ws.send(JSON.stringify({ type: 'complete', data: { is_final: true, audio: '' } }));
    });
  });

  const tts = new GnaniTTS('unit-test-key', { url: `ws://127.0.0.1:${port}/api/v1/tts` });
  const chunks = await tts.synthesize('Ramesh ka teen sau chaalis udhaar', {
    voice: 'Shivani',
    model: 'timbre-v3.0',
    language: 'hi-IN',
    speed: 1.0,
    sampleRate: 16000,
    container: 'raw',
  });

  eq('key sent in x-api-key-id header', upgradeHeaders['x-api-key-id'], 'unit-test-key');
  eq('request text', request?.text, 'Ramesh ka teen sau chaalis udhaar');
  eq('request voice', request?.voice, 'Shivani');
  eq('request model', request?.model, 'timbre-v3.0');
  eq('request language', request?.language, 'hi-IN');
  eq('request sample rate', request?.audio_config?.sample_rate, 16000);
  eq('request mono channel', request?.audio_config?.num_channels, 1);
  eq('request 16-bit samples', request?.audio_config?.sample_width, 2);
  eq('request raw container', request?.audio_config?.container, 'raw');

  eq('resolves on complete with both chunks', chunks.length, 2);
  check('audio payloads are base64 in play order', Buffer.concat(chunks.map((c) => Buffer.from(c.audio, 'base64'))).equals(Buffer.concat([pcmA, pcmB])));
  check('no timeout fallback was needed', chunks[1]?.is_final === true);

  wss.close();
}

// ---------------------------------------------------------------------------
// 4. Timbre error handling
// ---------------------------------------------------------------------------
console.log('\nTimbre v3.0 error handling');

{
  const wss = new WebSocketServer({ port: 0 });
  const port = await listen(wss);
  wss.on('connection', (ws) => {
    ws.on('message', () => ws.send(JSON.stringify({ type: 'error', message: 'invalid voice' })));
  });

  const tts = new GnaniTTS('unit-test-key', { url: `ws://127.0.0.1:${port}/api/v1/tts`, timeoutMs: 3000 });
  let error = null;
  try {
    await tts.synthesize('hello', {});
  } catch (err) {
    error = err;
  }
  check('rejects instead of returning silence', Boolean(error), 'synthesize resolved');
  check('surfaces the service message', Boolean(error && /invalid voice/.test(error.message)), error?.message);

  wss.close();
}

// ---------------------------------------------------------------------------

console.log(`\n${failed === 0 ? '✅' : '❌'} Gnani contract: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
