/**
 * Optional LLM fallback for phrasing the deterministic parser cannot read.
 *
 * Money never comes from the model on its own: this class only ever produces a
 * candidate structure, which the caller re-runs through the deterministic
 * parser and ledger validation. It is also only consulted when the local parser
 * returns "unknown", so the offline path and the exact-number path are unchanged
 * when no key is configured.
 */

const DEFAULT_BASE_URL = 'https://api.x.ai/v1';
const DEFAULT_MODEL = 'grok-4-fast';
const DEFAULT_TIMEOUT_MS = 2500;

const SYSTEM_PROMPT = [
  'You convert ONE spoken sentence from an Indian kirana shop into JSON.',
  'The speaker mixes Hindi, Hinglish and English. "udhaar" means credit given to',
  'a customer; "jama", "diya", "mila" or "payment" means money received.',
  'Reply with ONLY this JSON object, no prose:',
  '{"customerName": string, "amount": number, "type": "credit" | "payment", "confidence": number}',
  'Rules:',
  '- Copy the customer name exactly as spoken, without titles like "bhai" or "ji".',
  '- amount is a positive number in rupees, never a date, quantity or phone number.',
  '- If the sentence is a question, a correction, or not a ledger entry, use',
  '  {"customerName": null, "amount": 0, "type": "credit", "confidence": 0}.',
  '- Never invent a name or an amount that was not spoken.',
].join('\n');

export class LlmBrain {
  constructor({
    apiKey = process.env.LLM_API_KEY || process.env.GROK_API_KEY || process.env.XAI_API_KEY,
    model = process.env.LLM_MODEL || DEFAULT_MODEL,
    baseUrl = process.env.LLM_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs = Number(process.env.LLM_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.apiKey = typeof apiKey === 'string' ? apiKey.trim() : '';
    this.model = String(model || DEFAULT_MODEL);
    this.baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : null;
  }

  get enabled() {
    return Boolean(this.apiKey) && Boolean(this.fetchImpl);
  }

  /**
   * @returns {Promise<null | {customerName:string, amount:number, type:'credit'|'payment', confidence:number}>}
   */
  async parse(text, { customers = [] } = {}) {
    const sentence = String(text || '').trim();
    if (!this.enabled || !sentence) return null;

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
              content: customers.length
                ? `Known customers: ${customers.slice(0, 40).join(', ')}\nSentence: ${sentence}`
                : `Sentence: ${sentence}`,
            },
          ],
        }),
      });

      if (!response.ok) return null;
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content !== 'string') return null;
      return this._validate(content);
    } catch {
      // Timeout, network failure or a broken payload: the caller keeps the
      // deterministic answer, which is always safe.
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  _validate(content) {
    let parsed;
    try {
      const cleaned = content.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return null;
    }

    const customerName = typeof parsed?.customerName === 'string'
      ? parsed.customerName.trim().replace(/\s+/g, ' ')
      : '';
    const amount = Number(parsed?.amount);
    const type = parsed?.type === 'payment' ? 'payment' : (parsed?.type === 'credit' ? 'credit' : null);
    const confidence = Number(parsed?.confidence);

    if (!customerName || customerName.length > 60) return null;
    if (!/[A-Za-z\u0900-\u097F]/.test(customerName)) return null;
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return null;
    if (!type) return null;
    if (!Number.isFinite(confidence) || confidence < 0.55) return null;

    return { customerName, amount: Math.round(amount), type, confidence };
  }
}
