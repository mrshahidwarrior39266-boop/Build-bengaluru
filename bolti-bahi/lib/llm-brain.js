/**
 * Optional LLM "brain" for phrasing the deterministic parser cannot read.
 *
 * The model never writes money on its own. It can only propose a plan — action,
 * customer, amounts, direction, query kind — and the caller re-runs that plan
 * through the deterministic parser, ledger validation and audit path. The model
 * is also only consulted when the local parser is unsure (unreadable sentence,
 * missing customer, missing direction), so a normal "Ramesh ka 340 udhaar" costs
 * zero network calls and gives the same answer every time.
 */

import { scanAmounts, normalizeSpokenText } from './hindi-numbers.js';

const DEFAULT_TIMEOUT_MS = 3000;
const MIN_CONFIDENCE = 0.6;

/**
 * OpenAI-compatible endpoints. All take the same request shape, so a key from
 * any of them works without touching code; LLM_BASE_URL / LLM_MODEL still
 * override the preset when a provider renames a model.
 */
export const PROVIDERS = {
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free' },
  xai: { baseUrl: 'https://api.x.ai/v1', model: 'grok-4-fast' },
};

const DEFAULT_PROVIDER = process.env.LLM_PROVIDER
  || (process.env.GROQ_API_KEY ? 'groq' : (process.env.GEMINI_API_KEY ? 'gemini' : 'xai'));

export const QUERY_KINDS = new Set([
  'customer_balance',
  'today_credit',
  'today_payment',
  'today_summary',
  'top_debtor',
  'total_outstanding',
  'customer_count',
  'customer_list',
  'last_entry',
]);

const SYSTEM_PROMPT = [
  'You are the language brain of "Bolti Bahi", a voice ledger for Indian kirana shops.',
  'The speaker mixes Hindi, Hinglish and English. Speech recognition may have small errors.',
  'Convert ONE spoken sentence into ONE JSON object. Reply with ONLY the JSON, no prose.',
  '',
  'Schema:',
  '{"action":"entry"|"correction"|"query"|"unknown",',
  ' "customerName": string|null,',
  ' "entries": [{"amount": number, "type": "credit"|"payment"}],',
  ' "query": "customer_balance"|"today_credit"|"today_payment"|"today_summary"|"top_debtor"|"total_outstanding"|"customer_count"|"customer_list"|"last_entry"|null,',
  ' "confidence": number between 0 and 1}',
  '',
  'Direction rules:',
  '- "udhaar", "udhar", "baaki", "credit", "chadha" = credit (the customer owes more).',
  '- "jama", "diya", "diye", "mila", "aaya", "payment", "paid", "vasooli" = payment.',
  '',
  'Action rules:',
  '- entry: the speaker records a new credit or payment. Keep every clause, in order.',
  '- correction: the speaker fixes an earlier amount ("nahi, 430", "galat hai 400 kar do").',
  '- query: the speaker asks about the ledger, not writes to it.',
  '  customer_balance = one customer\'s balance; today_credit / today_payment / today_summary = today\'s totals;',
  '  top_debtor = who owes the most; total_outstanding = all outstanding; customer_count = how many customers;',
  '  customer_list = list customers; last_entry = the most recent entry.',
  '- unknown: anything you are not confident about. Never guess.',
  '',
  'Hard rules:',
  '- Copy the customer name as spoken, without titles like "bhai", "ji", "sir".',
  '- Use ONLY amounts that were actually spoken. Never invent, round or infer an amount.',
  '- A date, quantity, phone number or percentage is never an amount.',
  '- If a name is clearly one of the known customers but was misheard, use the known spelling.',
  '- If the sentence is only filler ("theek hai", "hmm"), return action "unknown" with confidence 0.',
].join('\n');

function round(value) {
  return Math.round(Number(value) || 0);
}

function cleanName(value) {
  return typeof value === 'string'
    ? value.trim().replace(/\s+/g, ' ').slice(0, 60)
    : '';
}

/** Lower-case and strip punctuation for name comparison. */
export function normalizeCustomerKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9\u0900-\u097F ]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length];
}

/**
 * Repair a name that STT misheard, but only when one existing customer is a
 * clear, unique match. A wrong attribution is worse than no attribution, so a
 * short name or a tie returns null and the normal clarification path runs.
 */
export function bestCustomerMatch(spoken, customers, { threshold = 0.84 } = {}) {
  const key = normalizeCustomerKey(spoken);
  if (!key) return null;

  const list = (customers || []).map((name) => String(name || '')).filter(Boolean);
  const exact = list.find((name) => normalizeCustomerKey(name) === key);
  if (exact) return exact;
  if (key.length < 3) return null;

  let best = null;
  let bestScore = 0;
  let tied = false;

  for (const name of list) {
    const candidateKey = normalizeCustomerKey(name);
    if (!candidateKey) continue;
    for (const variant of new Set([candidateKey, candidateKey.split(' ')[0]])) {
      if (!variant || variant.length < 3) continue;
      const score = 1 - levenshtein(key, variant) / Math.max(key.length, variant.length);
      if (score > bestScore + 1e-9) {
        best = name;
        bestScore = score;
        tied = false;
      } else if (Math.abs(score - bestScore) <= 1e-9 && best && name !== best) {
        tied = true;
      }
    }
  }

  return bestScore >= threshold && !tied ? best : null;
}

export class LlmBrain {
  constructor({
    apiKey = process.env.LLM_API_KEY || process.env.GROQ_API_KEY || process.env.GEMINI_API_KEY
      || process.env.OPENROUTER_API_KEY || process.env.GROK_API_KEY || process.env.XAI_API_KEY,
    provider = process.env.LLM_PROVIDER,
    model = process.env.LLM_MODEL,
    baseUrl = process.env.LLM_BASE_URL,
    mode = process.env.LLM_MODE || 'assist',
    timeoutMs = Number(process.env.LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    fetchImpl = globalThis.fetch,
  } = {}) {
    const rawKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    let autoProvider = provider;
    if (!autoProvider) {
      if (process.env.GROQ_API_KEY || rawKey.startsWith('gsk_')) autoProvider = 'groq';
      else if (process.env.GEMINI_API_KEY || rawKey.startsWith('AIza')) autoProvider = 'gemini';
      else if (process.env.OPENROUTER_API_KEY || rawKey.startsWith('sk-or-')) autoProvider = 'openrouter';
      else if (process.env.XAI_API_KEY || process.env.GROK_API_KEY || rawKey.startsWith('xai-')) autoProvider = 'xai';
      else autoProvider = DEFAULT_PROVIDER;
    }
    const requested = String(autoProvider || DEFAULT_PROVIDER).toLowerCase();
    this.provider = PROVIDERS[requested] ? requested : DEFAULT_PROVIDER;
    const preset = PROVIDERS[this.provider];
    this.apiKey = rawKey;
    this.model = String(model || preset.model);
    this.baseUrl = String(baseUrl || preset.baseUrl).replace(/\/+$/, '');
    this.mode = ['off', 'fallback', 'assist'].includes(String(mode)) ? String(mode) : 'assist';
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
  }

  get enabled() {
    return Boolean(this.apiKey) && Boolean(this.fetchImpl) && this.mode !== 'off';
  }

  /**
   * Backwards-compatible single-entry shape. New code should use
   * understand(), which can also describe corrections and queries.
   *
   * @returns {Promise<null | {customerName:string, amount:number, type:'credit'|'payment', confidence:number}>}
   */
  async parse(text, options = {}) {
    const plan = await this.understand(text, options);
    if (!plan || (plan.action !== 'entry' && plan.action !== 'correction')) return null;
    const first = plan.entries?.[0];
    if (!first) return null;
    return {
      customerName: plan.customerName,
      amount: first.amount,
      type: first.type,
      confidence: plan.confidence,
    };
  }

  /**
   * Ask the model for a structured plan. Returns null on any timeout, network
   * failure or unsafe answer; the caller then keeps the deterministic answer.
   *
   * @returns {Promise<null | {
   *   action:'entry'|'correction'|'query',
   *   customerName:string,
   *   entries:Array<{amount:number,type:'credit'|'payment'}>,
   *   query:string|null,
   *   confidence:number,
   *   model:string,
   * }>}
   */
  async understand(text, {
    customers = [],
    today = '',
    lastEntry = null,
  } = {}) {
    const sentence = String(text || '').trim();
    if (!this.enabled || !sentence) return null;

    const context = [
      today ? `Today's date: ${today}` : '',
      customers.length ? `Known customers: ${customers.slice(0, 40).join(', ')}` : '',
      lastEntry ? `Most recent entry: ${JSON.stringify(lastEntry)}` : '',
    ].filter(Boolean).join('\n');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            {
              role: 'user',
              content: `${context}\n\nSentence: ${sentence}`.trim(),
            },
          ],
        }),
      });

      if (!response.ok) return null;
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return null;
      const plan = this._validatePlan(content, { text: sentence });
      return plan ? { ...plan, model: this.model } : null;
    } catch {
      // Timeout, network failure or a broken payload: the caller keeps the
      // deterministic answer, which is always safe.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  _validatePlan(content, { text }) {
    let parsed;
    try {
      const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      const start = cleaned.indexOf('{');
      const end = cleaned.lastIndexOf('}');
      parsed = JSON.parse(start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned);
    } catch {
      return null;
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence) || confidence < MIN_CONFIDENCE) return null;

    const rawAction = String(parsed.action || '').toLowerCase();
    const hasLegacyEntry = parsed.amount !== undefined;
    const action = rawAction === 'correction' || rawAction === 'correct' ? 'correction'
      : rawAction === 'query' ? 'query'
        : rawAction === 'unknown' ? null
          : (rawAction === 'entry' || rawAction === 'entries' || hasLegacyEntry) ? 'entry'
            : null;
    if (!action) return null;

    const customerName = cleanName(parsed.customerName);
    if (customerName && (!/[A-Za-z\u0900-\u097F]/u.test(customerName) || customerName.length < 2)) {
      return null;
    }

    if (action === 'query') {
      const query = String(parsed.query || '').toLowerCase();
      if (!QUERY_KINDS.has(query)) return null;
      if (query === 'customer_balance' && !customerName) return null;
      return { action, customerName, entries: [], query, confidence };
    }

    // Entry and correction share the same amount/shape validation.
    const rawEntries = Array.isArray(parsed.entries)
      ? parsed.entries
      : (hasLegacyEntry ? [{ amount: parsed.amount, type: parsed.type }] : []);
    if (rawEntries.length === 0 || rawEntries.length > 5) return null;

    const entries = [];
    for (const item of rawEntries) {
      const amount = Number(item?.amount);
      const type = item?.type === 'payment' ? 'payment' : (item?.type === 'credit' ? 'credit' : null);
      if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return null;
      if (!type) return null;
      entries.push({ amount: round(amount), type });
    }

    if (action === 'entry' && !customerName) return null;
    if (action === 'correction' && entries.length !== 1) return null;

    // Ground every amount in the transcript. This is the key anti-hallucination
    // rule: if the deterministic scanner found money in the sentence, the model
    // may only reuse those exact numbers.
    const spoken = scanAmounts(normalizeSpokenText(text)).amounts.map((a) => round(a.value));
    if (spoken.length > 0 && entries.some((entry) => !spoken.includes(entry.amount))) return null;

    return { action, customerName, entries, query: null, confidence };
  }
}
