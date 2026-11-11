/**
 * Grok fallback contract: it must be opt-in, validated, and incapable of
 * writing a ledger row on its own.
 *
 * The stub server below speaks the same JSON shape as the xAI chat completions
 * API, so these tests run offline and never see a real key.
 *
 * Run: node test/test-llm-brain.js
 */

import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LlmBrain } from '../lib/llm-brain.js';
import { KhataAgent } from '../lib/agent.js';
import { LedgerDB } from '../lib/ledger-db.js';

let passed = 0;
let failed = 0;
function ok(condition, name, extra = '') {
  if (condition) { passed += 1; console.log(`  ✅ ${name}`); }
  else { failed += 1; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); }
}
function eq(actual, expected, name) {
  ok(actual === expected, name, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------- stub server
let mode = 'valid';
let hits = 0;

const stub = createServer((req, res) => {
  hits += 1;
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (mode === 'error500') return send(500, { error: 'boom' });
    if (mode === 'slow') {
      setTimeout(() => send(200, completion({ customerName: 'Neha', amount: 340, type: 'credit', confidence: 0.9 })), 400);
      return undefined;
    }

    const contents = {
      valid: JSON.stringify({ customerName: 'Neha', amount: 340, type: 'credit', confidence: 0.9 }),
      fenced: '```json\n{"customerName":"Neha","amount":340,"type":"credit","confidence":0.9}\n```',
      zeroAmount: JSON.stringify({ customerName: 'Neha', amount: 0, type: 'credit', confidence: 0.9 }),
      badType: JSON.stringify({ customerName: 'Neha', amount: 340, type: 'loan', confidence: 0.9 }),
      lowConfidence: JSON.stringify({ customerName: 'Neha', amount: 340, type: 'credit', confidence: 0.2 }),
      noName: JSON.stringify({ customerName: '12345', amount: 340, type: 'credit', confidence: 0.9 }),
      garbage: 'I think the customer owes about three hundred rupees.',
    };
    return send(200, completion(contents[mode] ?? contents.valid, true));
  });
});

function completion(content, raw = false) {
  return {
    choices: [{ message: { role: 'assistant', content: raw ? content : JSON.stringify(content) } }],
  };
}

await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve));
const port = stub.address().port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const dir = mkdtempSync(join(tmpdir(), 'khata-llm-'));
const ledger = new LedgerDB(join(dir, 'khata.db'));

try {
  console.log('\n🧠 LLM FALLBACK (GROK)\n');

  // 1. No key means no network at all.
  const off = new LlmBrain({ apiKey: '', baseUrl, fetchImpl: fetch });
  eq(off.enabled, false, 'Brain is disabled without a key');
  eq(await off.parse('wo baat likh do'), null, 'Disabled brain returns null');

  // 1b. Provider presets: a free-tier key just works, and overrides still win.
  eq(new LlmBrain({ apiKey: 'k', provider: 'groq' }).model, 'llama-3.3-70b-versatile', 'Groq preset model');
  eq(new LlmBrain({ apiKey: 'k', provider: 'groq' }).baseUrl, 'https://api.groq.com/openai/v1', 'Groq preset endpoint');
  eq(new LlmBrain({ apiKey: 'k', provider: 'openrouter' }).baseUrl, 'https://openrouter.ai/api/v1', 'OpenRouter preset endpoint');
  eq(new LlmBrain({ apiKey: 'k', provider: 'gemini' }).baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai', 'Gemini preset endpoint');
  eq(new LlmBrain({ apiKey: 'k' }).provider, 'xai', 'Default provider is xAI');
  eq(new LlmBrain({ apiKey: 'k', provider: 'nope' }).provider, 'xai', 'Unknown provider falls back to the default');
  const overridden = new LlmBrain({ apiKey: 'k', provider: 'groq', baseUrl: 'http://127.0.0.1:9/v1', model: 'custom-model' });
  eq(overridden.baseUrl, 'http://127.0.0.1:9/v1', 'Explicit base URL overrides the preset');
  eq(overridden.model, 'custom-model', 'Explicit model overrides the preset');

  // 2. A real shaped answer is accepted.
  const brain = new LlmBrain({ apiKey: 'test-key-not-real', baseUrl, fetchImpl: fetch });
  mode = 'valid';
  const valid = await brain.parse('wo baat likh do', { customers: [] });
  eq(valid?.customerName, 'Neha', 'Valid answer keeps the customer name');
  eq(valid?.amount, 340, 'Valid answer keeps the amount');
  eq(valid?.type, 'credit', 'Valid answer keeps the direction');

  mode = 'fenced';
  eq((await brain.parse('wo baat likh do'))?.amount, 340, 'Fenced JSON is accepted');

  // 3. Bad or dangerous answers are rejected outright.
  for (const [label, expected] of [
    ['zeroAmount', 'Zero amount is rejected'],
    ['badType', 'Unknown direction is rejected'],
    ['lowConfidence', 'Low confidence is rejected'],
    ['noName', 'Digits-only name is rejected'],
    ['garbage', 'Prose instead of JSON is rejected'],
    ['error500', 'A failed API call falls back'],
  ]) {
    mode = label;
    eq(await brain.parse('wo baat likh do'), null, expected);
  }

  // 4. A slow model must not stall a voice turn.
  mode = 'slow';
  const slow = new LlmBrain({ apiKey: 'test-key-not-real', baseUrl, fetchImpl: fetch, timeoutMs: 60 });
  const started = Date.now();
  eq(await slow.parse('wo baat likh do'), null, 'Timeout returns null instead of hanging');
  ok(Date.now() - started < 1000, 'Timeout is enforced promptly', `${Date.now() - started}ms`);

  // 5. The agent only consults the model when the local parser gives up.
  const stubBrain = {
    enabled: true,
    model: 'stub-model',
    calls: 0,
    async parse() {
      this.calls += 1;
      return { customerName: 'Neha', amount: 340, type: 'credit', confidence: 0.9 };
    },
  };
  const agent = new KhataAgent({
    ledger,
    brain: stubBrain,
    now: () => new Date('2026-11-11T10:00:00'),
  });

  const readable = await agent.handleAsync('Sunita ka 200 udhaar');
  eq(stubBrain.calls, 0, 'Model is not called when the sentence already parses');
  eq(readable.events.filter((e) => e.type === 'entry').length, 1, 'Local parse still writes the entry');

  const unknown = await agent.handleAsync('theek hai');
  eq(stubBrain.calls, 1, 'Model is called for an unreadable sentence');
  const entry = unknown.events.find((e) => e.type === 'entry');
  eq(entry?.entry?.customerName, 'Neha', 'Model hint is applied through the ledger pipeline');
  eq(entry?.entry?.amount, 340, 'Model hint amount is written once');
  eq(unknown.llm?.used, true, 'Result records that the fallback was used');

  // 6. Without a brain the same sentence stays unknown: nothing is invented.
  const plainAgent = new KhataAgent({ ledger, now: () => new Date('2026-11-11T10:00:00') });
  const plain = await plainAgent.handleAsync('theek hai');
  eq(plain.intent, 'unknown', 'No brain and no parse means no entry');
  eq(plain.events.length, 0, 'Unknown sentence writes no rows');
} catch (err) {
  failed += 1;
  console.error('  ❌ Unexpected error:', err.message);
} finally {
  ledger.close();
  stub.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failed === 0 ? '✅' : '❌'} LLM fallback: ${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
