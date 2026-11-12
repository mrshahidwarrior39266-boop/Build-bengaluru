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
import { LlmBrain, bestCustomerMatch } from '../lib/llm-brain.js';
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

  // 6. Assist mode: the model is consulted for a missing slot, but its plan is
  // still grounded, validated and written by the deterministic pipeline.
  const answer = (plan) => ({
    enabled: true,
    model: 'stub-model',
    calls: 0,
    plan,
    async understand() {
      this.calls += 1;
      return this.plan;
    },
  });

  // 6a. Missing customer: "340 udhaar" is a real entry with no name.
  const nameBrain = answer({
    action: 'entry',
    customerName: 'Neha',
    entries: [{ amount: 340, type: 'credit' }],
    query: null,
    confidence: 0.9,
  });
  const nameAgent = new KhataAgent({ ledger, brain: nameBrain, now: () => new Date('2026-11-11T10:00:00') });
  const noName = await nameAgent.handleAsync('340 udhaar');
  eq(nameBrain.calls, 1, 'Model is asked when the customer name is missing');
  eq(noName.events.find((e) => e.type === 'entry')?.entry?.customerName, 'Neha', 'Missing name is filled from the plan');
  eq(noName.llm?.action, 'entry', 'Assist result records the action');

  // 6b. Missing direction: "Neha 340" needs credit vs payment.
  const dirBrain = answer({
    action: 'entry',
    customerName: 'Neha',
    entries: [{ amount: 340, type: 'credit' }],
    query: null,
    confidence: 0.9,
  });
  const dirAgent = new KhataAgent({ ledger, brain: dirBrain, now: () => new Date('2026-11-11T10:00:00') });
  const noDir = await dirAgent.handleAsync('Neha 340');
  eq(dirBrain.calls, 1, 'Model is asked when the direction is missing');
  eq(noDir.events.find((e) => e.type === 'entry')?.entry?.type, 'credit', 'Missing direction is filled from the plan');

  // 6c. A question with no name is answered through the same path.
  const queryBrain = answer({
    action: 'query',
    customerName: 'Neha',
    entries: [],
    query: 'customer_balance',
    confidence: 0.9,
  });
  const queryAgent = new KhataAgent({ ledger, brain: queryBrain, now: () => new Date('2026-11-11T10:00:00') });
  const asked = await queryAgent.handleAsync('uska kitna baaki hai');
  eq(queryBrain.calls, 1, 'Model is asked for a nameless balance question');
  eq(asked.intent, 'query', 'Query plan returns a query result');
  eq(asked.events.find((e) => e.type === 'query')?.customer, 'Neha', 'Query plan resolves the customer');

  // 6d. A misheard known name is repaired, not duplicated as a new customer.
  ledger.addEntry({ customerName: 'Ramesh', amount: 50, type: 'credit' });
  const repairedBrain = answer({
    action: 'entry',
    customerName: 'Rameesh',
    entries: [{ amount: 100, type: 'credit' }],
    query: null,
    confidence: 0.9,
  });
  const repairedAgent = new KhataAgent({ ledger, brain: repairedBrain, now: () => new Date('2026-11-11T10:00:00') });
  const repaired = await repairedAgent.handleAsync('Rameesh 100');
  eq(repaired.events.find((e) => e.type === 'entry')?.entry?.customerName, 'Ramesh', 'Misheard name maps to the known customer');
  eq(repaired.llm?.nameRepaired, true, 'Result records that the name was repaired');

  // 6e. One sentence can contain two clauses, in the spoken order.
  const multiBrain = answer({
    action: 'entry',
    customerName: 'Neha',
    entries: [
      { amount: 200, type: 'credit' },
      { amount: 50, type: 'payment' },
    ],
    query: null,
    confidence: 0.9,
  });
  const multiAgent = new KhataAgent({ ledger, brain: multiBrain, now: () => new Date('2026-11-11T10:00:00') });
  const multi = await multiAgent.handleAsync('Neha do sau pachaas');
  const multiEntries = multi.events.filter((e) => e.type === 'entry').map((e) => e.entry);
  eq(multiEntries.length, 2, 'Two clauses create two entries');
  eq(multiEntries[0]?.type, 'credit', 'First clause keeps credit');
  eq(multiEntries[1]?.type, 'payment', 'Second clause keeps payment');

  // 7. Plan validation rejects hallucinated money and unsupported actions.
  eq(bestCustomerMatch('Rameesh', ['Ramesh', 'Suresh']), 'Ramesh', 'Unique fuzzy name match is repaired');
  eq(bestCustomerMatch('Ram', ['Ramesh']), null, 'Too-short names are never force-matched');
  eq(bestCustomerMatch('Devi', ['Ravi', 'Neha']), null, 'No clear name match stays unresolved');

  const hallu = brain._validatePlan(JSON.stringify({
    action: 'entry', customerName: 'Neha',
    entries: [{ amount: 999, type: 'credit' }], confidence: 0.9,
  }), { text: 'Neha ka 340 udhaar' });
  eq(hallu, null, 'An amount not spoken in the sentence is rejected');

  const unsupported = brain._validatePlan(JSON.stringify({
    action: 'unknown', customerName: null, entries: [], confidence: 0.2,
  }), { text: 'theek hai' });
  eq(unsupported, null, 'Unknown action stays unknown');

  const queryPlan = brain._validatePlan(JSON.stringify({
    action: 'query', customerName: 'Neha', entries: [], query: 'customer_balance', confidence: 0.8,
  }), { text: 'Neha ka kitna baaki hai' });
  eq(queryPlan?.query, 'customer_balance', 'Valid query plan is accepted');

  const badQuery = brain._validatePlan(JSON.stringify({
    action: 'query', customerName: '', entries: [], query: 'weather', confidence: 0.8,
  }), { text: 'mausam kaisa hai' });
  eq(badQuery, null, 'Unknown query kind is rejected');

  // 8. Without a brain the same sentence stays unknown: nothing is invented.
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
