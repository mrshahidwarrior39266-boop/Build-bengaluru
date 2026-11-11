/**
 * KhataAgent: the conversation brain.
 *
 * One agent per voice session. It never touches sockets or UI; it turns a
 * transcript into ledger events plus one short spoken line, so the same code
 * path is exercised by the judge harness, the REST API and the WebSocket demo.
 */

import { parseIntent, extractCustomer } from './intent-parser.js';
import { LlmBrain } from './llm-brain.js';
import { normalizeSpokenText } from './hindi-numbers.js';
import { safeSpeech } from './speech-guard.js';
import { buildReminder } from './reminders.js';
import { localYmd } from './shop-date.js';

export const AI_DISCLOSURE =
  'Namaste! Main Bolti Bahi ka AI assistant hoon. Aap bolkar udhaar aur jama likhwa sakte hain. Bataiye, kya likhna hai?';

const ORDINALS = [
  ['pehla', 'pahla', 'pehle', 'pratham', 'first', '1', 'ek', 'one'],
  ['dusra', 'doosra', 'dusre', 'dusri', 'second', '2', 'do', 'two'],
  ['teesra', 'tisra', 'third', '3', 'teen', 'three'],
];

const CANCEL_WORDS = ['nahi', 'nahin', 'nhi', 'cancel', 'chhodo', 'chodo', 'rehne do', 'no'];

function round(value) {
  return Math.round(Number(value) || 0);
}

function balanceLine(name, balance) {
  const value = round(balance);
  if (value === 0) return `${name} ka hisaab chukta hai.`;
  if (value < 0) return `${name} ke paas ${Math.abs(value)} rupay advance hai.`;
  return `${name} ka ${value} rupay baaki hai.`;
}

export class KhataAgent {
  constructor({ ledger, now = () => new Date(), brain = null }) {
    if (!ledger) throw new Error('KhataAgent requires a ledger');
    this.ledger = ledger;
    this.now = now;
    this.brain = brain;
    this.pending = null;
    this.lastEntryId = null;
  }

  /**
   * Entry point used by the server. It is identical to handle() unless an LLM
   * fallback is configured AND the deterministic parser could not read the
   * sentence; even then the model's proposal is re-parsed and validated by the
   * local parser before any row is written.
   */
  async handleAsync(rawText) {
    const text = String(rawText || '').trim();
    if (!text || !this.brain || !this.brain.enabled || this.pending) return this.handle(text);

    const deterministic = parseIntent(text, { now: this.now() });
    if (deterministic.intent !== 'unknown') return this.handle(text);

    const hint = await this.brain.parse(text, {
      customers: this.ledger.getCustomerSummary().slice(0, 40).map((row) => row.customer_name),
    });
    if (!hint) return this.handle(text);

    // Re-enter the normal pipeline with a canonical phrase so name resolution,
    // ambiguity questions, validation and audit notes all still apply.
    const phrase = hint.type === 'credit'
      ? `${hint.customerName} ka ${hint.amount} udhaar`
      : `${hint.customerName} se ${hint.amount} jama`;
    const result = this.handle(phrase);
    if (!result.events.some((event) => event.type === 'entry')) return this.handle(text);
    return { ...result, llm: { used: true, model: this.brain.model, confidence: hint.confidence } };
  }

  get disclosureText() {
    return AI_DISCLOSURE;
  }

  handle(rawText) {
    const started = Date.now();
    const text = String(rawText || '').trim();
    const now = this.now();

    if (!text) {
      return this._result('unknown', 'Kuch sunai nahi diya. Dobara boliye.', [], started);
    }

    if (this.pending) {
      const resolved = this._resolvePending(text, now);
      if (resolved) return this._result(resolved.intent, resolved.spoken, resolved.events, started);
    }

    const parsed = parseIntent(text, { now });

    switch (parsed.intent) {
      case 'refuse':
        return this._result('refuse', this._refusalText(parsed.refusal), [], started);

      case 'reminder':
        return this._handleReminder(parsed, started);

      case 'query':
        return this._handleQuery(parsed, started);

      case 'correct':
        return this._handleCorrection(parsed, started);

      case 'clarify_direction':
        return this._askDirection(parsed, started);

      case 'entry':
      case 'entries':
        return this._handleEntries(parsed, started);

      default:
        return this._result(
          'unknown',
          'Samajh nahi aaya. Jaise bolein: Ramesh ka 340 udhaar.',
          [],
          started,
        );
    }
  }

  _result(intent, spoken, events, startedAtMs) {
    return {
      intent,
      spoken: safeSpeech(spoken),
      events,
      latencyMs: Date.now() - startedAtMs,
    };
  }

  _refusalText(kind) {
    if (kind === 'lending') {
      return 'Main paisa udhaar dene ya uske badle paise lene ki salah nahi deta. Sirf dukaan ka khata likhta hoon.';
    }
    return 'Main sehat ki salah nahi deta. Doctor se poochein.';
  }

  _handleReminder(parsed, started) {
    const reminder = buildReminder(this.ledger, parsed.customer);
    if (!reminder.allowed) {
      const reasons = {
        not_opted_in: `${parsed.customer} ne reminder ke liye opt-in nahi kiya, isliye reminder nahi bhejunga.`,
        nothing_due: `${parsed.customer} ka koi baaki nahi hai, reminder ki zaroorat nahi.`,
        unknown_customer: `${parsed.customer || 'Is grahak'} ka koi hisaab nahi mila.`,
        no_customer: 'Kis grahak ko reminder bhejna hai? Naam bolein.',
        ambiguous_customer: 'Ek se zyada grahak mil rahe hain. Poora naam bolein.',
      };
      const spoken = reasons[reminder.reason] || 'Reminder nahi bhej sakta.';
      return this._result('reminder', spoken, [
        { type: 'reminder', allowed: false, reason: reminder.reason },
      ], started);
    }
    return this._result(
      'reminder',
      `${reminder.customer} ko polite reminder taiyaar hai, lekin demo mein koi message nahi bheja gaya.`,
      [{ type: 'reminder', allowed: true, text: reminder.text, delivered: false }],
      started,
    );
  }

  _applyEntries(customerName, entries, transcript) {
    const saved = this.ledger.addEntries(entries.map((entry) => ({
      customerName,
      amount: entry.amount,
      type: entry.type,
      date: entry.date,
      note: transcript,
    })));

    const balance = this.ledger.getCustomerBalance(customerName).balance;
    this.lastEntryId = saved[saved.length - 1].id;
    return { saved, balance };
  }

  _entriesSpoken(saved, balance) {
    const name = saved[0].customerName;
    if (saved.length === 1) {
      const entry = saved[0];
      const label = entry.type === 'credit' ? 'udhaar' : 'jama';
      return `${name} ka ${round(entry.amount)} rupay ${label} likh diya. ${balanceLine(name, balance)}`;
    }
    const parts = saved.map((e) => `${round(e.amount)} ${e.type === 'credit' ? 'udhaar' : 'jama'}`);
    return `${name}: ${parts.join(', ')}. ${balanceLine(name, balance)}`;
  }

  _handleEntries(parsed, started) {
    if (!parsed.customer) {
      this.pending = { kind: 'name_for_entry', entries: parsed.entries, transcript: parsed.transcript };
      return this._result('clarify', 'Kiska hisaab likhna hai? Grahak ka naam bolein.', [
        { type: 'clarification', question: 'Kiska hisaab likhna hai? Grahak ka naam bolein.', options: [] },
      ], started);
    }

    const resolution = this.ledger.resolveCustomer(parsed.customer);

    if (resolution.status === 'ambiguous') {
      this.pending = {
        kind: 'name',
        entries: parsed.entries,
        transcript: parsed.transcript,
        spokenName: parsed.customer,
        candidates: resolution.candidates,
      };
      return this._askWhichCustomer(parsed.customer, resolution.candidates, started);
    }

    const name = resolution.status === 'exact' ? resolution.customer.name : parsed.customer;
    const { saved, balance } = this._applyEntries(name, parsed.entries, parsed.transcript);

    const events = saved.map((entry) => ({
      type: 'entry',
      entry: { ...entry, balance },
      balance,
      corrected: false,
    }));

    return this._result(parsed.intent, this._entriesSpoken(saved, balance), events, started);
  }

  _askWhichCustomer(spokenName, candidates, started) {
    const options = candidates.slice(0, 3).map((c) => ({
      name: c.name,
      balance: round(this.ledger.getCustomerBalance(c.name).balance),
    }));
    const list = options.map((o) => `${o.name}, ${o.balance} rupay baaki`).join('; ');
    const question = `${options.length} grahak milte hain: ${list}. Kaunsa? Pehla ya doosra bolein.`;
    return this._result('clarify', question, [
      { type: 'clarification', question: safeSpeech(question), options },
    ], started);
  }

  _askDirection(parsed, started) {
    this.pending = {
      kind: 'direction',
      entries: parsed.entries.map((e) => ({ ...e, type: null })),
      customer: parsed.customer,
      transcript: parsed.transcript,
    };
    const question = parsed.customer
      ? `${parsed.customer} ka ${round(parsed.entries[0].amount)} rupay udhaar hai ya jama?`
      : 'Yeh udhaar hai ya jama? Udhaar ya jama bolein.';
    return this._result('clarify', question, [
      { type: 'clarification', question: safeSpeech(question), options: [{ name: 'udhaar' }, { name: 'jama' }] },
    ], started);
  }

  _handleCorrection(parsed, started) {
    let entry = null;
    let customerName = null;

    if (parsed.customer) {
      const resolution = this.ledger.resolveCustomer(parsed.customer);
      if (resolution.status === 'ambiguous') {
        this.pending = {
          kind: 'correction_name',
          amount: parsed.amount,
          transcript: parsed.transcript,
          spokenName: parsed.customer,
          candidates: resolution.candidates,
        };
        return this._askWhichCustomer(parsed.customer, resolution.candidates, started);
      }
      if (resolution.status === 'exact') {
        customerName = resolution.customer.name;
        entry = this.ledger.getLastEntry(customerName);
      }
    } else if (this.lastEntryId) {
      entry = this.ledger.getEntryById(this.lastEntryId);
    }

    if (!entry) entry = this.ledger.getLastEntry(customerName);

    if (!entry) {
      return this._result('correct', 'Abhi koi entry nahi hai jo badal sakoon.', [], started);
    }

    const updated = this.ledger.correctEntryById(entry.id, parsed.amount);
    this.lastEntryId = updated.id;
    const balance = this.ledger.getCustomerBalance(updated.customerName).balance;
    const spoken = `${updated.customerName} ka ${round(updated.corrected_from)} se ${round(updated.amount)} rupay kar diya. ${balanceLine(updated.customerName, balance)}`;

    return this._result('correct', spoken, [{
      type: 'entry',
      entry: { ...updated, balance },
      balance,
      corrected: true,
    }], started);
  }

  _handleQuery(parsed, started) {
    const { query } = parsed;
    // "Aaj" means the shop's day, the same calendar the entries are stamped in.
    const todayStr = localYmd(this.now());

    if (query.kind === 'customer_balance') {
      if (!parsed.customer) {
        return this._result('query', 'Kis grahak ka hisaab? Naam bolein.', [], started);
      }
      const resolution = this.ledger.resolveCustomer(parsed.customer);
      if (resolution.status === 'ambiguous') {
        this.pending = {
          kind: 'query_name',
          query,
          spokenName: parsed.customer,
          candidates: resolution.candidates,
        };
        return this._askWhichCustomer(parsed.customer, resolution.candidates, started);
      }
      if (resolution.status === 'none') {
        return this._result('query', `${parsed.customer} ka koi hisaab nahi mila.`, [
          { type: 'query', kind: query.kind, value: 0, found: false },
        ], started);
      }
      const balance = this.ledger.getCustomerBalance(resolution.customer.name);
      return this._result('query', balanceLine(balance.customerName, balance.balance), [
        { type: 'query', kind: query.kind, customer: balance.customerName, value: round(balance.balance), totalCredit: round(balance.totalCredit), totalPayment: round(balance.totalPayment) },
      ], started);
    }

    if (query.kind === 'today_credit' || query.kind === 'today_payment') {
      const summary = this.ledger.getTodaySummary(todayStr);
      const isCredit = query.kind === 'today_credit';
      const value = round(isCredit ? summary.total_credit : summary.total_payment);
      const spoken = value === 0
        ? (isCredit ? 'Aaj koi udhaar nahi gaya.' : 'Aaj koi jama nahi hua.')
        : (isCredit ? `Aaj ${value} rupay udhaar gaya.` : `Aaj ${value} rupay jama hua.`);
      return this._result('query', spoken, [
        { type: 'query', kind: query.kind, value, date: todayStr, transactions: summary.total_transactions },
      ], started);
    }

    if (query.kind === 'today_summary') {
      const summary = this.ledger.getTodaySummary(todayStr);
      const spoken = `Aaj ${round(summary.total_credit)} rupay udhaar aur ${round(summary.total_payment)} rupay jama.`;
      return this._result('query', spoken, [{
        type: 'query',
        kind: query.kind,
        date: todayStr,
        credit: round(summary.total_credit),
        payment: round(summary.total_payment),
      }], started);
    }

    if (query.kind === 'top_debtor') {
      const summary = this.ledger.getCustomerSummary().filter((c) => c.balance > 0);
      if (summary.length === 0) {
        return this._result('query', 'Abhi kisi ka baaki nahi hai.', [
          { type: 'query', kind: query.kind, value: null },
        ], started);
      }
      const top = summary[0];
      return this._result('query', `${top.customer_name} ka sabse zyada ${round(top.balance)} rupay baaki hai.`, [{
        type: 'query', kind: query.kind, customer: top.customer_name, value: round(top.balance),
      }], started);
    }

    if (query.kind === 'total_outstanding') {
      const total = round(this.ledger.getTotalOutstanding());
      return this._result('query', `Kul ${total} rupay udhaar baaki hai.`, [
        { type: 'query', kind: query.kind, value: total },
      ], started);
    }

    if (query.kind === 'customer_count') {
      const count = this.ledger.getCustomerSummary().length;
      return this._result('query', `${count} grahak khate mein hain.`, [
        { type: 'query', kind: query.kind, value: count },
      ], started);
    }

    if (query.kind === 'customer_list') {
      const names = this.ledger.getCustomerSummary().slice(0, 4).map((c) => c.customer_name);
      const spoken = names.length === 0 ? 'Khata khali hai.' : `Khate mein: ${names.join(', ')}.`;
      return this._result('query', spoken, [
        { type: 'query', kind: query.kind, names },
      ], started);
    }

    if (query.kind === 'last_entry') {
      const entry = parsed.customer
        ? this.ledger.getLastEntry(parsed.customer)
        : this.ledger.getLastEntry();
      if (!entry) return this._result('query', 'Abhi koi entry nahi hai.', [], started);
      const label = entry.type === 'credit' ? 'udhaar' : 'jama';
      return this._result('query', `${entry.customerName} ka ${round(entry.amount)} rupay ${label}, ${entry.date}.`, [{
        type: 'query', kind: query.kind, customer: entry.customerName, value: round(entry.amount), entryType: entry.type,
      }], started);
    }

    const summary = this.ledger.getTodaySummary(todayStr);
    return this._result('query', `Aaj ${round(summary.total_credit)} rupay udhaar aur ${round(summary.total_payment)} rupay jama.`, [
      { type: 'query', kind: 'today_summary', credit: round(summary.total_credit), payment: round(summary.total_payment) },
    ], started);
  }

  _matchCandidate(answer, candidates) {
    const normalized = normalizeSpokenText(answer);
    if (!normalized) return null;

    for (let i = 0; i < ORDINALS.length; i += 1) {
      if (ORDINALS[i].some((word) => normalized === word || normalized.startsWith(`${word} `))) {
        return candidates[i] || null;
      }
    }

    const tokens = normalized.split(/\s+/).filter((t) => !CANCEL_WORDS.includes(t));
    const matches = candidates.filter((c) => {
      const cname = c.normalized_name;
      const offered = normalizeSpokenText(c.name);
      return normalized.includes(cname) || normalized.includes(offered) ||
        cname.split(' ').every((part) => tokens.includes(part));
    });
    if (matches.length === 1) return matches[0];
    return null;
  }

  _applyPendingToCustomer(customer, pending) {
    if (pending.kind === 'query_name') {
      const balance = this.ledger.getCustomerBalance(customer.name);
      return {
        intent: 'query',
        spoken: balanceLine(balance.customerName, balance.balance),
        events: [{
          type: 'query',
          kind: pending.query.kind,
          customer: balance.customerName,
          value: round(balance.balance),
          totalCredit: round(balance.totalCredit),
          totalPayment: round(balance.totalPayment),
        }],
      };
    }

    if (pending.kind === 'correction_name') {
      const entry = this.ledger.getLastEntry(customer.name);
      if (!entry) {
        return { intent: 'correct', spoken: `${customer.name} ka koi hisaab nahi mila.`, events: [] };
      }
      const updated = this.ledger.correctEntryById(entry.id, pending.amount);
      this.lastEntryId = updated.id;
      const balance = this.ledger.getCustomerBalance(updated.customerName).balance;
      return {
        intent: 'correct',
        spoken: `${updated.customerName} ka ${round(updated.corrected_from)} se ${round(updated.amount)} kar diya. ${balanceLine(updated.customerName, balance)}`,
        events: [{ type: 'entry', entry: { ...updated, balance }, balance, corrected: true }],
      };
    }

    const { saved, balance } = this._applyEntries(
      customer.name,
      pending.entries,
      pending.transcript,
    );
    return {
      intent: 'entries',
      spoken: this._entriesSpoken(saved, balance),
      events: saved.map((entry) => ({ type: 'entry', entry: { ...entry, balance }, balance, corrected: false })),
    };
  }

  _resolvePending(text, now) {
    const pending = this.pending;
    const normalized = normalizeSpokenText(text);

    if (pending.kind === 'direction') {
      let type = null;
      if (/(?:udhaa?r|udhar|credit)/.test(normalized)) type = 'credit';
      if (/(?:jama|jamaa|payment|diya|diye|mila|mile)/.test(normalized)) type = 'payment';

      if (!type) {
        const question = 'Udhaar ya jama? Sirf udhaar ya jama bolein.';
        return { intent: 'clarify', spoken: question, events: [{ type: 'clarification', question }] };
      }

      const entries = pending.entries.map((e) => ({ ...e, type }));
      const transcript = `${pending.transcript} ${text}`.trim();
      this.pending = null;

      if (!pending.customer) {
        this.pending = { kind: 'name_for_entry', entries, transcript };
        return { intent: 'clarify', spoken: 'Kiska hisaab likhna hai? Naam bolein.', events: [{ type: 'clarification', question: 'Kiska hisaab likhna hai? Naam bolein.' }] };
      }

      const resolution = this.ledger.resolveCustomer(pending.customer);
      if (resolution.status === 'ambiguous') {
        this.pending = { kind: 'name', entries, transcript, spokenName: pending.customer, candidates: resolution.candidates };
        const list = resolution.candidates.slice(0, 3).map((c) => c.name).join(' aur ');
        const question = `${list} milte hain. Kaunsa? Pehla ya doosra bolein.`;
        return { intent: 'clarify', spoken: question, events: [{ type: 'clarification', question }] };
      }
      const name = resolution.status === 'exact' ? resolution.customer.name : pending.customer;
      const { saved, balance } = this._applyEntries(name, entries, transcript);
      return {
        intent: 'entries',
        spoken: this._entriesSpoken(saved, balance),
        events: saved.map((entry) => ({ type: 'entry', entry: { ...entry, balance }, balance, corrected: false })),
      };
    }

    // Name-based clarifications.
    if (CANCEL_WORDS.includes(normalized.split(/\s+/)[0] || '')) {
      this.pending = null;
      return { intent: 'clarify', spoken: 'Theek hai, cancel kar diya.', events: [] };
    }

    const byOrdinal = this._matchCandidate(normalized, pending.candidates || []);

    if (byOrdinal) {
      this.pending = null;
      return this._applyPendingToCustomer(byOrdinal, pending);
    }

    if (pending.kind === 'name_for_entry') {
      const name = extractCustomer(normalized);
      if (name) {
        this.pending = null;
        const resolution = this.ledger.resolveCustomer(name);
        if (resolution.status === 'ambiguous') {
          this.pending = { ...pending, kind: 'name', spokenName: name, candidates: resolution.candidates };
          return this._askWhichCustomerResult(name, resolution.candidates, now);
        }
        const target = resolution.status === 'exact' ? resolution.customer.name : name;
        const { saved, balance } = this._applyEntries(target, pending.entries, pending.transcript);
        return {
          intent: 'entries',
          spoken: this._entriesSpoken(saved, balance),
          events: saved.map((entry) => ({ type: 'entry', entry: { ...entry, balance }, balance, corrected: false })),
        };
      }
    }

    if (pending.kind === 'name') {
      const name = extractCustomer(normalized);
      if (name) {
        const resolution = this.ledger.resolveCustomer(name);
        if (resolution.status !== 'ambiguous') {
          this.pending = null;
          const target = resolution.status === 'exact' ? resolution.customer.name : name;
          const customer = resolution.customer || this.ledger.findOrCreateCustomer(target);
          return this._applyPendingToCustomer(customer, pending);
        }
      }
    }

    const question = `Samajh nahi aaya. ${pending.spokenName || ''} ke liye pehla ya doosra bolein.`.trim();
    return { intent: 'clarify', spoken: question, events: [{ type: 'clarification', question }] };
  }

  _askWhichCustomerResult(spokenName, candidates) {
    const list = candidates.slice(0, 3).map((c) => c.name).join(' aur ');
    return {
      intent: 'clarify',
      spoken: `${list} milte hain. Kaunsa? Pehla ya doosra bolein.`,
      events: [{ type: 'clarification', question: `${list} milte hain. Kaunsa? Pehla ya doosra bolein.` }],
    };
  }
}
