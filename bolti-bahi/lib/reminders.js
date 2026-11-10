/**
 * Polite, opt-in-only balance reminders.
 *
 * Guardrails implemented here (track rules):
 *   - a reminder is only produced for customers who explicitly opted in
 *   - wording stays neutral and helpful: no pressure, no threats, no deadlines
 *   - no new credit is offered and no interest/lending language is used
 *
 * The demo does not send messages to anyone; it only proves the policy and the
 * wording, and says so honestly.
 */

import { isCompliantSpeech, safeSpeech } from './speech-guard.js';

const TEMPLATES = [
  (name, amount) =>
    `Namaste ${name} ji, aapke khate mein ${amount} rupay baaki hai. Jab suvidha ho tab dukaan par aa sakte hain. Dhanyavaad.`,
  (name, amount) =>
    `${name} ji, namaste. Aapka ${amount} rupay ka hisaab khata mein darj hai. Jab aapko theek lage tab baat kar sakte hain. Dhanyavaad.`,
];

/**
 * Build a reminder for a customer, or explain why it is not allowed.
 * @param {object} ledger LedgerDB instance
 * @param {string} name spoken/typed customer name
 * @returns {{allowed:boolean, reason?:string, text?:string, amount?:number}}
 */
export function buildReminder(ledger, name) {
  if (!name) {
    return { allowed: false, reason: 'no_customer' };
  }

  const resolution = ledger.resolveCustomer(name);
  if (resolution.status === 'ambiguous') {
    return { allowed: false, reason: 'ambiguous_customer', candidates: resolution.candidates.map((c) => c.name) };
  }
  if (resolution.status === 'none') {
    return { allowed: false, reason: 'unknown_customer' };
  }

  const customer = resolution.customer;
  if (!Number(customer.reminder_opt_in)) {
    return { allowed: false, reason: 'not_opted_in', customer: customer.name };
  }

  const balance = ledger.getCustomerBalance(customer.name);
  if (!balance.balance || balance.balance <= 0) {
    return { allowed: false, reason: 'nothing_due', customer: customer.name };
  }

  const template = TEMPLATES[0];
  const text = safeSpeech(template(customer.name, Math.round(balance.balance)));
  if (!isCompliantSpeech(text)) {
    return { allowed: false, reason: 'blocked_by_guard' };
  }

  return { allowed: true, text, amount: Math.round(balance.balance), customer: customer.name, delivered: false };
}
