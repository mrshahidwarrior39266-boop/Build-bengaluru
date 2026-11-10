/**
 * Spoken number parser for Indian shop speech (Hindi / Hinglish / English mix).
 *
 * Handles, in one pass:
 *   - Hindi cardinals: "teen sau chaalis" -> 340, "bees" -> 20
 *   - Asian multipliers: sau / hazaar / lakh / crore, and "5k"
 *   - Fractional prefixes: "dedh sau" -> 150, "dhai sau" -> 250,
 *     "sawa do sau" -> 225, "paune do sau" -> 175, "saadhe teen sau" -> 350
 *   - English shorthand: "three-forty" -> 340, "three hundred forty" -> 340
 *   - Native digits: Devanagari "३४०" -> 340 (plus 7 other Indic digit sets)
 *   - Digit grouping: "1,20,000" -> 120000, "1.5 hazaar" -> 1500
 *
 * The parser is deliberately deterministic: no network, no model, so a ledger
 * entry costs microseconds and the same words always produce the same amount.
 */

// Indic digit blocks (codepoint of the zero digit). Offsets 1-9 follow it.
const DIGIT_ZERO_CODEPOINTS = [
  0x0966, // Devanagari
  0x09e6, // Bengali
  0x0a66, // Gurmukhi
  0x0ae6, // Gujarati
  0x0b66, // Odia
  0x0be6, // Tamil
  0x0c66, // Telugu
  0x0ce6, // Kannada
  0x0d66, // Malayalam
];

const HINDI_UNITS = {
  ek: 1, ik: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, panch: 5, paanch: 5,
  chhah: 6, chhe: 6, che: 6, saat: 7, aath: 8, nau: 9, no: 9,
  das: 10, dus: 10, gyaarah: 11, gyara: 11, baarah: 12, barah: 12, terah: 13,
  chaudah: 14, pandrah: 15, solah: 16, satrah: 17, athaarah: 18, unees: 19,
  bees: 20, bis: 20, ikkees: 21, baees: 22, teis: 23, chaubees: 24,
  pachees: 25, chhabbees: 26, sattaees: 27, atthaees: 28, untees: 29,
  tees: 30, ikattees: 31, battees: 32, taintees: 33, chauntees: 34,
  paintees: 35, chhattees: 36, saintees: 37, adtees: 38, untaalees: 39,
  chaalees: 40, chaalis: 40, chalis: 40, iktaalees: 41, bayaalees: 42,
  taintaalees: 43, chavaalees: 44, paintaalees: 45, chhiyaalees: 46,
  saintaalees: 47, adtaalees: 48, unchaas: 49,
  pachaas: 50, pachas: 50, ikyaavan: 51, baavan: 52, tirpan: 53, chauvan: 54,
  pachpan: 55, chhappan: 56, sattaavan: 57, athaavan: 58, unsath: 59,
  saath: 60, saathi: 60, iksath: 61, baasath: 62, tirsath: 63, chaunsath: 64,
  painsath: 65, chhiyaasath: 66, sadsath: 67, adsath: 68, unhattar: 69,
  sattar: 70, ikattar: 71, bahattar: 72, tihattar: 73, chauhattar: 74,
  pachhattar: 75, chhihattar: 76, satattar: 77, athhattar: 78, unnaasi: 79,
  assi: 80, ikyaasi: 81, bayaasi: 82, tiraasi: 83, chauraasi: 84,
  pachaasi: 85, chhiyaasi: 86, sattaasi: 87, atthaasi: 88, navaasi: 89,
  nabbe: 90, nabe: 90, ikyaanve: 91, baanve: 92, tiraaanve: 93,
  chauraanve: 94, panchaanve: 95, chhiyaanve: 96, sattaanve: 97,
  atthaanve: 98, ninyaanve: 99,

  // Devanagari (STT frequently returns native script)
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5, 'छह': 6, 'छे': 6,
  'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10, 'ग्यारह': 11, 'बारह': 12, 'तेरह': 13,
  'चौदह': 14, 'पंद्रह': 15, 'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19,
  'बीस': 20, 'इक्कीस': 21, 'बाईस': 22, 'तेईस': 23, 'चौबीस': 24, 'पच्चीस': 25,
  'छब्बीस': 26, 'सत्ताईस': 27, 'अट्ठाईस': 28, 'उनतीस': 29, 'तीस': 30,
  'इकतीस': 31, 'बत्तीस': 32, 'तैंतीस': 33, 'चौंतीस': 34, 'पैंतीस': 35,
  'छत्तीस': 36, 'सैंतीस': 37, 'अड़तीस': 38, 'उनतालीस': 39, 'चालीस': 40,
  'इकतालीस': 41, 'बयालीस': 42, 'तैंतालीस': 43, 'चवालीस': 44, 'पैंतालीस': 45,
  'छियालीस': 46, 'सैंतालीस': 47, 'अड़तालीस': 48, 'उनचास': 49, 'पचास': 50,
  'इक्यावन': 51, 'बावन': 52, 'तिरपन': 53, 'चौवन': 54, 'पचपन': 55, 'छप्पन': 56,
  'सत्तावन': 57, 'अट्ठावन': 58, 'उनसठ': 59, 'साठ': 60, 'इकसठ': 61, 'बासठ': 62,
  'तिरसठ': 63, 'चौंसठ': 64, 'पैंसठ': 65, 'छियासठ': 66, 'सड़सठ': 67,
  'अड़सठ': 68, 'उनहत्तर': 69, 'सत्तर': 70, 'इकहत्तर': 71, 'बहत्तर': 72,
  'तिहत्तर': 73, 'चौहत्तर': 74, 'पचहत्तर': 75, 'छिहत्तर': 76, 'सतहत्तर': 77,
  'अठहत्तर': 78, 'उनासी': 79, 'अस्सी': 80, 'इक्यासी': 81, 'बयासी': 82,
  'तिरासी': 83, 'चौरासी': 84, 'पचासी': 85, 'छियासी': 86, 'सत्तासी': 87,
  'अट्ठासी': 88, 'नवासी': 89, 'नब्बे': 90, 'इक्यानवे': 91, 'बानवे': 92,
  'तिरानवे': 93, 'चौरानवे': 94, 'पचानवे': 95, 'छियानवे': 96, 'सत्तानवे': 97,
  'अट्ठानवे': 98, 'निन्यानवे': 99,
};

const ENGLISH_UNITS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13,
  fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

const MULTIPLIERS = {
  sau: 100, so: 100, sai: 100, 'सौ': 100,
  hazaar: 1000, hazar: 1000, hajaar: 1000, hajar: 1000, thousand: 1000,
  'हज़ार': 1000, 'हजार': 1000,
  lakh: 100000, lac: 100000, lakhs: 100000, 'लाख': 100000,
  crore: 10000000, karod: 10000000, crores: 10000000, 'करोड़': 10000000,
  hundred: 100, million: 1000000,
};

const PREFIXES = {
  dedh: 0.5, 'डेढ़': 0.5, dedha: 0.5,
  dhai: 1.5, 'ढाई': 1.5, dhaai: 1.5,
  sawa: 0.25, sava: 0.25, 'सवा': 0.25,
  paune: -0.25, pauna: -0.25, pone: -0.25, 'पौने': -0.25, 'पौन': -0.25,
  saadhe: 0.5, sadhe: 0.5, 'साढ़े': 0.5,
};

const CURRENCY_WORDS = new Set([
  '₹', 'rs', 'rs.', 'rupee', 'rupees', 'rupay', 'rupaye', 'rupya', 'rupaiya',
  'paisa', 'paise', 'रुपये', 'रुपया', 'रुपए', 'रु',
]);

// Words that are also Hindi number words but usually verbs in shop speech
// ("200 de do"). A single-token run made of these is not an amount.
const VERB_LOOKALIKES = new Set(['do', 'de', 'dee', 'di']);

/** Convert native Indic digits to ASCII digits. */
export function normalizeIndicDigits(text) {
  if (!text) return '';
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    let mapped = ch;
    for (const base of DIGIT_ZERO_CODEPOINTS) {
      if (cp >= base && cp <= base + 9) {
        mapped = String(cp - base);
        break;
      }
    }
    out += mapped;
  }
  return out;
}

/**
 * Lower-case, normalise digits/dashes and expand English "three-forty"
 * shorthand into a plain number. Column positions are recomputed afterwards,
 * so callers must use the returned string consistently.
 */
export function normalizeSpokenText(text) {
  if (!text) return '';
  let s = normalizeIndicDigits(String(text)).toLowerCase();
  s = s.replace(/[\u2010-\u2015\u2212]/g, '-');
  s = s.replace(/\brs\.?\s*/g, ' ');
  // "three-forty" / "three-forty-five" -> 340 / 345
  s = s.replace(
    /\b(one|two|three|four|five|six|seven|eight|nine)-(ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fourty|fifty|sixty|seventy|eighty|ninety)(?:-(one|two|three|four|five|six|seven|eight|nine))?\b/g,
    (m, a, b, c) => {
      const hundreds = ENGLISH_UNITS[a];
      const rest = ENGLISH_UNITS[b] + (c ? ENGLISH_UNITS[c] : 0);
      return String(hundreds * 100 + rest);
    },
  );
  s = s.replace(/[ \t]+/g, ' ').trim();
  return s;
}

function cleanToken(raw) {
  return raw.replace(/^[^\w\u0900-\u097F₹]+|[^\w\u0900-\u097F₹%]+$/gu, '');
}

function tokenKind(token) {
  if (!token) return null;
  if (PREFIXES[token] !== undefined) return { type: 'prefix', value: PREFIXES[token] };
  if (MULTIPLIERS[token] !== undefined) return { type: 'mult', value: MULTIPLIERS[token] };
  if (HINDI_UNITS[token] !== undefined) return { type: 'unit', value: HINDI_UNITS[token] };
  if (ENGLISH_UNITS[token] !== undefined) return { type: 'unit', value: ENGLISH_UNITS[token] };
  if (/^\d+(?:\.\d+)?$/.test(token)) return { type: 'unit', value: parseFloat(token) };
  // "5k", "5l", "2cr"
  const suffixed = token.match(/^(\d+(?:\.\d+)?)(k|l|lakh|lac|cr|crore)$/);
  if (suffixed) {
    const mult = { k: 1000, l: 100000, lakh: 100000, lac: 100000, cr: 10000000, crore: 10000000 };
    return { type: 'unit', value: parseFloat(suffixed[1]) * mult[suffixed[2]] };
  }
  return null;
}

function isCurrency(token) {
  return CURRENCY_WORDS.has(token);
}

function normalizeNumberToken(token) {
  // "1,20,000" -> 120000
  if (/^\d{1,3}(?:,\d{2,3})+(?:\.\d+)?$/.test(token)) return token.replace(/,/g, '');
  return token;
}

/**
 * Scan a normalised utterance for amounts.
 * @returns {{amounts: Array<{value:number,start:number,end:number,raw:string}>, masked:string}}
 *          `masked` is the same string with every amount span blanked out.
 */
export function scanAmounts(normalizedText) {
  const text = normalizedText || '';
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0];
    const cleaned = cleanToken(raw);
    tokens.push({
      raw,
      norm: normalizeNumberToken(cleaned),
      start: m.index,
      end: m.index + raw.length,
    });
  }

  const amounts = [];
  let i = 0;

  while (i < tokens.length) {
    const first = tokens[i];
    if (!first || isCurrency(first.norm)) { i += 1; continue; }

    const firstKind = tokenKind(first.norm);
    if (!firstKind) { i += 1; continue; }

    let j = i;
    let prefixDelta = 0;
    let hasPrefix = false;
    if (firstKind.type === 'prefix') {
      hasPrefix = true;
      prefixDelta = firstKind.value;
      j += 1;
    }

    let current = 0;
    let total = 0;
    let simpleMultiplier = null;
    let countForMultiplier = null;
    let lastIdx = null;
    let numberTokens = 0;

    for (; j < tokens.length; j += 1) {
      const tok = tokens[j];
      if (!tok) break;
      if (isCurrency(tok.norm)) continue;
      const kind = tokenKind(tok.norm);
      if (!kind || kind.type === 'prefix') break;

      if (kind.type === 'mult') {
        if (current === 0) current = 1;
        if (countForMultiplier === null) countForMultiplier = current;
        if (simpleMultiplier === null) simpleMultiplier = kind.value;
        total += current * kind.value;
        current = 0;
      } else {
        current += kind.value;
      }
      lastIdx = j;
      numberTokens += 1;
    }

    if (lastIdx === null) { i += 1; continue; }

    let value = total + current;
    if (hasPrefix) {
      const count = countForMultiplier !== null ? countForMultiplier : (value || 1);
      const base = simpleMultiplier !== null ? simpleMultiplier : 1;
      value = (count + prefixDelta) * base;
    }

    const rawSpan = text.slice(tokens[i].start, tokens[lastIdx].end);
    const singleToken = numberTokens === 1 && !hasPrefix;
    const verbLookalike = singleToken && VERB_LOOKALIKES.has(tokens[i].norm) &&
      (amounts.length > 0 || /\d/.test(text));

    if (!verbLookalike && Number.isFinite(value) && value > 0) {
      amounts.push({ value, start: tokens[i].start, end: tokens[lastIdx].end, raw: rawSpan });
      i = lastIdx + 1;
    } else {
      i += 1;
    }
  }

  // Blank out amount spans so name extraction cannot see them.
  let masked = '';
  let cursor = 0;
  for (const a of amounts) {
    masked += text.slice(cursor, a.start) + ' ';
    cursor = a.end;
  }
  masked += text.slice(cursor);

  return { amounts, masked };
}

/** First amount in an utterance, or null. */
export function parseSpokenAmount(text) {
  const { amounts } = scanAmounts(normalizeSpokenText(text));
  return amounts.length > 0 ? amounts[0].value : null;
}

/**
 * Backwards-compatible helper: return the text with spoken numbers turned into
 * digits, leaving all other words untouched.
 */
export function parseHindiNumbers(text) {
  const normalized = normalizeSpokenText(text);
  const { amounts } = scanAmounts(normalized);
  let out = '';
  let cursor = 0;
  for (const a of amounts) {
    out += normalized.slice(cursor, a.start) + String(a.value);
    cursor = a.end;
  }
  out += normalized.slice(cursor);
  return out.replace(/\s+/g, ' ').trim();
}

/** All numbers in a text, digit or word form, in spoken order. */
export function extractNumbers(text) {
  const { amounts } = scanAmounts(normalizeSpokenText(text));
  return amounts.map((a) => ({ value: a.value, original: a.raw }));
}

export const _internals = { tokenKind, PREFIXES, MULTIPLIERS };
