/**
 * Deterministic intent parser for shop-counter speech.
 *
 * Turns one utterance into a ledger plan: customer, amounts, credit vs payment,
 * relative date, corrections and questions. Runs fully on-device (no API key,
 * no network) so a live judge sentence is understood in well under 2 seconds,
 * and the same sentence always produces the same ledger result.
 */

import { normalizeSpokenText, scanAmounts, _internals } from './hindi-numbers.js';
import { localYmd } from './shop-date.js';

const { tokenKind } = _internals;

// Hinglish is spoken, but Prisma often returns Devanagari. Every pattern below
// therefore covers both scripts: without the Devanagari alternatives a normal
// transcript like "रमेश का ३४० उधार" was treated as a payment or, worse, as a
// customer named "का उधार".
const CREDIT_RE = /(?:udhaa?r|udhaari|udhari|credit|khata|khate|baaki|bakaya|likh|likha|chadha|saman|maal|le\s*gaya|le\s*liya|उधा[रर]|उधारी|क्रेडिट|खाता|खाते|बाकी|बकाया|लिख|लिखा|चढ़ा|सामान|माल|ले\s*गया|ले\s*लिया)/u;
const GIFT_CREDIT_RE = /(?:\bko\b|को)[\s\S]*(?:\bde\s*do\b|\bdo\b|\bdena\b|\bde\s*dena\b|\bdijiye\b|दे\s*दो|दो|देना|दे\s*देना|दीजिए)/u;
const PAYMENT_RE = /(?:\bdiya\b|\bdiye\b|\bdi\b|de\s*diya|de\s*diye|jama|jamaa|payment|\bpay\b|bhugtan|bhugtaan|vasooli|wasooli|chukta|chuka|wapas|\bmila\b|\bmile\b|aaya|aaye|received|paid|deposit|दिया|दिए|दी|दे\s*दिया|दे\s*दिए|जमा|जम्मा|पेमेंट|भुगतान|वसूली|चुकता|चुका|वापस|मिला|मिले|आया|आए)/u;
const CORRECTION_RE = /(?:^|\b)(?:nahi|nahin|nhi|no|galat|galti|sorry|maafi|matlab|actually|correction|correct|badal|badlo|change|theek|sahi)\b|(?:kar\s*do|kardo|kar\s*de)\s*$|(?:^|[\s,;])(?:नहीं|नही|गलत|गलती|माफी|माफ़ी|मतलब|सुधार|बदल|बदलो|ठीक|सही)(?=[\s,;.!?।]|$)|(?:कर\s*दो|करदो|कर\s*दे)\s*$/u;

const QUERY_RE = /(?:kitna|kitne|kitni|total|hisaab|hisab|baaki|baki|balance|batao|bata|bolo|bataye|how much|list|kiski|kiska|kaun|sabse|summary|kya\s+hai|कितना|कितने|कितनी|कुल|हिसाब|हिसाब-किताब|बाकी|बैलेंस|बताओ|बता|बोलो|बताइए|किसकी|किसका|कौन|सबसे|सारांश|क्या\s*है)/u;

const LENDING_RE = /(?:\bbyaj\b|\bbyaaj\b|\binterest\b|\bkarz\b|\bkarza\b|\bloan\b|\bemi\b|\binstal+ments?\b|\bcash\s*advance\b|\bfinance\b|ब्याज|ब्याज़|कर्ज|कर्ज़|लोन|ईएमआई|किस्त|फाइनेंस)/u;
const HEALTH_RE = /(?:\bdawa\b|\bdawai\b|\bdavai\b|\bdose\b|\bdosage\b|\bilaaj\b|\bilaj\b|\bdoctor\b|\btablet\b|\binjection\b|\bbimari\b|\bhealth\b|\bmedical\b|\bprescription\b|दवा|दवाई|दवाईयाँ|डोज़|इलाज|डॉक्टर|गोली|टैबलेट|इंजेक्शन|बीमारी|सेहत|मेडिकल|पर्चा)/u;
const REMINDER_RE = /(?:reminder|yaad\s*dila|yaad\s*dilao|remind|रिमाइंडर|याद\s*दिला|याद\s*दिलाओ)/u;

const DATE_TOMORROW_RE = /(?:kal\s*(?:denge|dena|dega|deg|tak|aana|aayenge)|tomorrow|agle\s*din|कल\s*(?:देंगे|देना|देगा|दें|तक|आना|आएंगे)|आगले\s*दिन)/u;
const DATE_PARSO_RE = /(?:\bparso\b|\bparson\b|day\s*before\s*yesterday|परसों|परसो)/u;
const DATE_YESTERDAY_RE = /(?:\bkal\b|\byesterday\b|\bkal\s*ka\b|(?:^|\s)कल(?:\s|$)|बीता\s*कल)/u;
const DATE_WEEK_RE = /(?:pichhle\s*hafte|last\s*week|saat\s*din\s*pehle|पिछले\s*हफ्ते|पिछले\s*सप्ताह|सात\s*दिन\s*पहले)/u;

// Words that can never be part of a customer name.
const NAME_STOPWORDS = new Set([
  'ka', 'ke', 'ki', 'ko', 'ne', 'se', 'mein', 'me', 'mai', 'par', 'pe', 'tak',
  'hai', 'hain', 'ha', 'tha', 'the', 'thi', 'th', 'hu', 'ho', 'hua', 'hue',
  'gaya', 'gayi', 'gaye', 'gai',
  'diya', 'diye', 'di', 'de', 'do', 'dena', 'denge', 'dijiye', 'dedo', 'dega',
  'likh', 'likho', 'likhna', 'likhdo', 'likha', 'chadha', 'chadhao',
  'kar', 'karo', 'kardo', 'karke', 'jama', 'jamaa',
  'udhaar', 'udhar', 'udhaari', 'udhari', 'credit', 'payment', 'pay', 'paid',
  'bhugtan', 'bhugtaan', 'vasooli', 'wasooli', 'chukta', 'chuka', 'wapas',
  'mila', 'mile', 'aaya', 'aaye', 'received', 'deposit',
  'aaj', 'aj', 'kal', 'parso', 'parson', 'abhi', 'subah', 'sham', 'raat',
  'dopahar', 'today', 'yesterday', 'tomorrow',
  'total', 'hisaab', 'hisab', 'baki', 'baaki', 'bakaya', 'kul', 'kitna',
  'kitne', 'kitni', 'batao', 'bata', 'bolo', 'bol', 'bataye', 'bataiye',
  'please', 'plz', 'arre', 'are', 'oye', 'hey', 'namaste', 'namaskar',
  'ji', 'bhai', 'bhaiya', 'sir', 'madam', 'sahab', 'sahib',
  'dukaan', 'dukan', 'khata', 'khate', 'aur', 'and', 'then', 'to', 'bhi',
  'na', 'nahi', 'nahin', 'nhi', 'no', 'not',
  'rupay', 'rupaye', 'rupees', 'rs', 'rupee', 'rupya', 'paisa', 'paise', '₹',
  'mera', 'meri', 'mujhe', 'uska', 'uski', 'iska', 'iski', 'unka', 'unki',
  'usse', 'usne', 'isse', 'isne', 'unse', 'unhe', 'unhone', 'mil', 'milti', 'milta',
  'sab', 'sabhi', 'saare', 'saara', 'sari', 'sabka',
  'kiski', 'kiska', 'kisne', 'kaun', 'kaunsa', 'kaunsi', 'kaunse', 'sabse',
  'zyada', 'jyada', 'top', 'list', 'summary', 'outstanding', 'balance',
  'entry', 'pichhli', 'pichhla', 'aakhri', 'last', 'recent', 'new', 'naya', 'nayi',
  'correction', 'correct', 'galat', 'galti', 'sorry', 'maafi', 'matlab',
  'actually', 'change', 'badal', 'badlo', 'theek', 'sahi',
  'reminder', 'yaad', 'dila', 'dilao', 'bhejo', 'send', 'hisaab-kitaab',

  // Devanagari stopwords. Prisma v3.0 often returns Hindi in native script, so
  // these must be filtered exactly like their Latin spellings or a transcript
  // such as "रमेश का ३४० उधार" creates a customer called "का उधार".
  'का', 'के', 'की', 'को', 'ने', 'से', 'में', 'मैं', 'पर', 'पे', 'तक',
  'है', 'हैं', 'हा', 'था', 'थे', 'थी', 'हूं', 'हूँ', 'हो', 'हुआ', 'हुए',
  'गया', 'गई', 'गए', 'गइ',
  'दिया', 'दिए', 'दी', 'दे', 'दो', 'देना', 'देंगे', 'दीजिए', 'देगा', 'देदो',
  'लिख', 'लिखो', 'लिखना', 'लिखदो', 'लिखा', 'चढ़ा', 'चढ़ाओ', 'चढ़ाया',
  'कर', 'करो', 'करदो', 'करके', 'जमा', 'जम्मा',
  'उधार', 'उधारी', 'क्रेडिट', 'पेमेंट', 'भुगतान', 'वसूली', 'चुकता',
  'चुका', 'वापस', 'मिला', 'मिले', 'आया', 'आए', 'रिसीव्ड',
  'आज', 'अज', 'कल', 'परसों', 'परसो', 'अभी', 'सुबह', 'शाम', 'रात', 'दोपहर',
  'कुल', 'हिसाब', 'हिसाब-किताब', 'बाकी', 'बकाया', 'कितना', 'कितने',
  'कितनी', 'बताओ', 'बता', 'बोलो', 'बोल', 'बताइए', 'बताईये',
  'कृपया', 'अरे', 'अर्रे', 'ओए', 'हे', 'नमस्ते', 'नमस्कार',
  'जी', 'भाई', 'भैया', 'सर', 'मैडम', 'साहब', 'साहिब',
  'दुकान', 'दुकानदार', 'खाता', 'खाते', 'और', 'फिर', 'तो', 'भी',
  'न', 'नहीं', 'नही', 'ना',
  'रुपये', 'रुपया', 'रुपए', 'रूपये', 'पैसा', 'पैसे', 'रु',
  'मेरा', 'मेरी', 'मुझे', 'उसका', 'उसकी', 'इसका', 'इसकी', 'उनका', 'उनकी',
  'उसने', 'इसने', 'उन्होंने', 'उससे', 'इससे', 'उनसे', 'मिल', 'मिलता', 'मिलती',
  'सब', 'सभी', 'सारे', 'सारा', 'सारी', 'सबका',
  'किसकी', 'किसका', 'किसने', 'कौन', 'कौनसा', 'कौनसी', 'कौनसे', 'सबसे',
  'ज़्यादा', 'ज्यादा', 'टॉप', 'सूची', 'सारांश', 'बैलेंस',
  'एंट्री', 'पिछली', 'पिछला', 'आखिरी', 'लास्ट', 'नया', 'नई',
  'सुधार', 'गलत', 'गलती', 'माफी', 'माफ़ी', 'मतलब',
  'बदल', 'बदलो', 'ठीक', 'सही',
  'रिमाइंडर', 'याद', 'दिला', 'दिलाओ', 'भेजो', 'भेज',
]);

function titleCaseAscii(name) {
  return name
    .split(' ')
    .map((w) => (/^[a-z]/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/** Masked text -> clean customer name ('' when none). */
export function extractCustomer(maskedText) {
  const tokens = (maskedText || '')
    .replace(/[.,!?;:"'`()\[\]{}/\\|।॥]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .split(/\s+/)
    .filter(Boolean);

  const kept = [];
  for (const raw of tokens) {
    const token = raw.trim();
    if (!token) continue;
    if (NAME_STOPWORDS.has(token)) continue;
    if (/^\d+$/.test(token)) continue;
    if (tokenKind(token)) continue; // stray number word
    if (token.length < 2) continue;
    if (/^[-–]+$/.test(token)) continue;
    kept.push(token);
    if (kept.length === 4) break;
  }

  if (kept.length === 0) return '';
  return titleCaseAscii(kept.join(' '));
}


function shiftDays(date, days) {
  const d = new Date(date.getTime());
  d.setDate(d.getDate() + days);
  return d;
}

export function resolveDate(text, now = new Date()) {
  if (DATE_TOMORROW_RE.test(text)) return localYmd(shiftDays(now, 1));
  if (DATE_PARSO_RE.test(text)) return localYmd(shiftDays(now, -2));
  if (DATE_YESTERDAY_RE.test(text)) return localYmd(shiftDays(now, -1));
  if (DATE_WEEK_RE.test(text)) return localYmd(shiftDays(now, -7));
  return localYmd(now);
}

function detectDirection(text) {
  if (/(?:udhaa?r|credit)\s*(?:diya|de\s*diya|de\s*diye)/.test(text)) return 'credit';
  if (GIFT_CREDIT_RE.test(text)) return 'credit';
  if (PAYMENT_RE.test(text)) return 'payment';
  if (CREDIT_RE.test(text)) return 'credit';
  return null;
}

function splitSegments(text) {
  const segments = [];
  // A comma inside digits is Indian grouping ("1,20,000"), not a clause break.
  const re = /(?:,(?!\d)|;|\.\s+|\s+(?:aur|and|plus|then)\s+)/g;
  let last = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    segments.push(text.slice(last, m.index));
    last = re.lastIndex;
  }
  segments.push(text.slice(last));
  return segments.map((s) => s.trim()).filter(Boolean);
}

function detectQuery(text, customer) {
  if (/(?:sabse\s*(?:zyada|jyada)|top\s*(?:customer|debtor|grahak)|highest|kaun\s*sabse|kiski\s*sabse|सबसे\s*(?:ज़्यादा|ज्यादा)|कौन\s*सबसे|किसकी\s*सबसे)/u.test(text)) {
    return { kind: 'top_debtor', customer: null };
  }
  if (/(?:kitne|how\s*many)\s*(?:customer|grahak|log|aadmi|party)/.test(text) || /(?:customer|grahak)\s*(?:kitne|count)/.test(text) ||
      /(?:कितने|कितनी)\s*(?:ग्राहक|लोग|आदमी|पार्टी)|(?:ग्राहक|लोग)\s*(?:कितने|कितनी)/u.test(text)) {
    return { kind: 'customer_count', customer: null };
  }
  if (/(?:list|sabhi\s*grahak|saare\s*grahak|sabka\s*hisaab|सूची|सभी\s*ग्राहक|सारे\s*ग्राहक|सबका\s*हिसाब)/u.test(text)) {
    return { kind: 'customer_list', customer: null };
  }
  if (/(?:aaj|today|आज)/u.test(text)) {
    if (/(?:jama|jamaa|payment|vasooli|wasooli|aaya|aaye|mila|mile|जमा|जम्मा|पेमेंट|वसूली|आया|आए|मिला|मिले)/u.test(text)) {
      return { kind: 'today_payment', customer: null };
    }
    if (/(?:udhaa?r|credit|उधा[रर]|क्रेडिट)/u.test(text)) return { kind: 'today_credit', customer: null };
    return { kind: 'today_summary', customer: null };
  }
  if (/(?:kul|total|sabka|outstanding)[\s\S]*(?:baaki|baki|udhaa?r)/.test(text) ||
      /(?:total|kul)\s*(?:outstanding|baaki|baki)/.test(text) ||
      /(?:कुल|टोटल)[\s\S]*(?:बाकी|बकाया|उधा[रर])|(?:कुल|टोटल)\s*(?:बाकी|बकाया)/u.test(text)) {
    return { kind: 'total_outstanding', customer: null };
  }
  if (/(?:aakhri|last|pichhli|recent)\s*(?:entry|transaction|len-?den)/.test(text) ||
      /(?:आखिरी|पिछली|हाल\s*की)\s*(?:एंट्री|लेन-?देन|ट्रांजैक्शन)/u.test(text)) {
    return { kind: 'last_entry', customer: customer || null };
  }
  // A bare name ("ok", "hmm") is not a balance question; require a question
  // word or an explicit possessive so filler never becomes a customer lookup.
  if (customer && (QUERY_RE.test(text) || /\b(?:ka|ki|ke)\b/.test(text) || /(?:^|\s)(?:का|की|के)(?:\s|$)/u.test(text))) {
    return { kind: 'customer_balance', customer };
  }
  if (/(?:hisaab|hisab|summary|total|हिसाब|सारांश|कुल|टोटल)/u.test(text)) return { kind: 'today_summary', customer: null };
  if (QUERY_RE.test(text)) return { kind: 'customer_balance', customer: null };
  return null;
}

/**
 * Parse one shop utterance.
 *
 * @param {string} text raw transcript
 * @param {{now?: Date}} options
 * @returns {object} intent plan consumed by KhataAgent
 */
export function parseIntent(text, { now = new Date() } = {}) {
  const normalized = normalizeSpokenText(text);
  const base = { normalized, transcript: String(text || '').trim() };

  if (!normalized) return { ...base, intent: 'unknown', customer: '', amounts: [] };

  // Compliance gates come first: never advise on credit/interest or health.
  if (LENDING_RE.test(normalized)) return { ...base, intent: 'refuse', refusal: 'lending', customer: '', amounts: [] };
  if (HEALTH_RE.test(normalized)) return { ...base, intent: 'refuse', refusal: 'health', customer: '', amounts: [] };

  const { amounts, masked } = scanAmounts(normalized);
  const customer = extractCustomer(masked);
  const globalDirection = detectDirection(normalized);
  const globalDate = resolveDate(normalized, now);

  if (REMINDER_RE.test(normalized)) {
    return { ...base, intent: 'reminder', customer, amounts };
  }

  if (amounts.length === 0) {
    const query = detectQuery(normalized, customer);
    if (query) return { ...base, intent: 'query', query, customer, amounts };
    return { ...base, intent: 'unknown', customer, amounts };
  }

  if (CORRECTION_RE.test(normalized) && !globalDirection) {
    return { ...base, intent: 'correct', amount: amounts[0].value, customer, amounts, date: globalDate };
  }

  const segments = splitSegments(normalized);
  const entries = [];

  for (const segment of segments) {
    const scan = scanAmounts(segment);
    if (scan.amounts.length === 0) continue;
    const direction = detectDirection(segment) || globalDirection;
    const date = resolveDate(segment, now) || globalDate;
    for (const amount of scan.amounts) {
      entries.push({ type: direction, amount: amount.value, date });
    }
  }

  if (entries.length === 0) {
    return { ...base, intent: 'unknown', customer, amounts };
  }

  const missingDirection = entries.some((e) => !e.type);
  if (missingDirection) {
    return {
      ...base,
      intent: 'clarify_direction',
      customer,
      amounts,
      entries: entries.map((e) => ({ ...e, type: e.type || null })),
    };
  }

  return { ...base, intent: entries.length > 1 ? 'entries' : 'entry', customer, amounts, entries, date: globalDate };
}
