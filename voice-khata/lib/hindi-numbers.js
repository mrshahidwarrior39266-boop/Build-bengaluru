/**
 * Indic & Hinglish Number Normalizer
 * Converts spoken number words (Hindi, Hinglish, English code-mix, Devanagari) to digits.
 * Handles:
 *  - "teen sau chaalis" → 340
 *  - "three-forty" / "three forty" → 340
 *  - "four-thirty" / "four thirty" → 430
 *  - "dedh sau" → 150, "dhai sau" → 250, "sawa sau" → 125, "paune do sau" → 175
 *  - "सात सौ पचास" → 750
 *  - "३४०" → 340
 */

const DEVANAGARI_DIGITS = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9'
};

const HINDI_UNITS = {
  // 1-10
  'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'chaar': 4, 'paanch': 5, 'panch': 5,
  'chhah': 6, 'chhe': 6, 'saat': 7, 'aath': 8, 'nau': 9, 'das': 10,
  // 11-20
  'gyaarah': 11, 'gyarah': 11, 'baarah': 12, 'barah': 12, 'terah': 13, 'chaudah': 14,
  'pandrah': 15, 'solah': 16, 'satrah': 17, 'athaarah': 18, 'atharah': 18, 'unees': 19,
  'bees': 20,
  // 21-30
  'ikkees': 21, 'baees': 22, 'teis': 23, 'chaubees': 24, 'pachees': 25,
  'chhabbees': 26, 'sattaees': 27, 'atthaees': 28, 'untees': 29, 'tees': 30,
  // 31-40
  'ikattees': 31, 'battees': 32, 'taintees': 33, 'chauntees': 34, 'paintees': 35,
  'chhattees': 36, 'saintees': 37, 'adtees': 38, 'untaalees': 39,
  'chaalees': 40, 'chaalis': 40, 'chalis': 40,
  // 41-50
  'iktaalees': 41, 'bayaalees': 42, 'taintaalees': 43, 'chavaalees': 44, 'paintaalees': 45,
  'chhiyaalees': 46, 'saintaalees': 47, 'adtaalees': 48, 'unchaas': 49,
  'pachaas': 50, 'pachas': 50,
  // 51-60
  'ikyaavan': 51, 'baavan': 52, 'tirpan': 53, 'chauvan': 54, 'pachpan': 55,
  'chhappan': 56, 'sattaavan': 57, 'athaavan': 58, 'unsath': 59,
  'saath': 60, 'sath': 60, 'saathi': 60,
  // 61-70
  'iksath': 61, 'baasath': 62, 'tirsath': 63, 'chaunsath': 64, 'painsath': 65,
  'chhiyaasath': 66, 'sadsath': 67, 'adsath': 68, 'unhattar': 69,
  'sattar': 70,
  // 71-80
  'ikattar': 71, 'bahattar': 72, 'tihattar': 73, 'chauhattar': 74, 'pachhattar': 75,
  'chhi-hattar': 76, 'satattar': 77, 'athhattar': 78, 'unnaasi': 79,
  'assi': 80,
  // 81-90
  'ikyaasi': 81, 'bayaasi': 82, 'tiraasi': 83, 'chauraasi': 84, 'pachaasi': 85,
  'chhiyaasi': 86, 'sattaasi': 87, 'atthaasi': 88, 'navaasi': 89,
  'nabbe': 90, 'nabbey': 90, 'nabe': 90,
  // 91-99
  'ikyaanve': 91, 'baanve': 92, 'tiraaanve': 93, 'chauraanve': 94, 'panchaanve': 95,
  'chhiyaanve': 96, 'sattaanve': 97, 'atthaanve': 98, 'ninyaanve': 99,

  // English units & tens
  'one': 1, 'two': 2, 'three': 3, 'four': 4, 'five': 5,
  'six': 6, 'seven': 7, 'eight': 8, 'nine': 9, 'ten': 10,
  'eleven': 11, 'twelve': 12, 'thirteen': 13, 'fourteen': 14, 'fifteen': 15,
  'sixteen': 16, 'seventeen': 17, 'eighteen': 18, 'nineteen': 19,
  'twenty': 20, 'thirty': 30, 'forty': 40, 'fourty': 40, 'fifty': 50,
  'sixty': 60, 'seventy': 70, 'eighty': 80, 'ninety': 90,

  // Devanagari units & words
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पाँच': 5, 'पांच': 5,
  'छह': 6, 'सात': 7, 'आठ': 8, 'नौ': 9, 'दस': 10,
  'ग्यारह': 11, 'बारह': 12, 'तेरह': 13, 'चौदह': 14, 'पंद्रह': 15,
  'सोलह': 16, 'सत्रह': 17, 'अठारह': 18, 'उन्नीस': 19, 'बीस': 20,
  'तीस': 30, 'चालीस': 40, 'पचास': 50, 'साठ': 60, 'सत्तर': 70, 'अस्सी': 80, 'नब्बे': 90
};

const HINDI_MULTIPLIERS = {
  'sau': 100, 'so': 100, 'सौ': 100,
  'hundred': 100,
  'hazaar': 1000, 'hazar': 1000, 'hajaar': 1000, 'हज़ार': 1000, 'हजार': 1000,
  'thousand': 1000, 'k': 1000,
  'lakh': 100000, 'lac': 100000, 'लाख': 100000,
  'crore': 10000000, 'karod': 10000000, 'करोड़': 10000000
};

const SPECIAL_NUMBERS = {
  // English colloquial combinations (e.g. "three-forty" -> 340)
  'three-forty': 340, 'three forty': 340,
  'four-thirty': 430, 'four thirty': 430,
  'two-fifty': 250, 'two fifty': 250,
  'one-twenty': 120, 'one twenty': 120,
  'one-fifty': 150, 'one fifty': 150,
  'seven-fifty': 750, 'seven fifty': 750,
  'six-forty': 640, 'six forty': 640,
  'eight-twenty': 820, 'eight twenty': 820,
  'nine-fifty': 950, 'nine fifty': 950,
  'five-forty': 540, 'five forty': 540,
  'three-twenty': 320, 'three twenty': 320,
  'two-twenty': 220, 'two twenty': 220,

  // "dedh" prefix = 1.5x
  'dedh sau': 150, 'dedh hazaar': 1500, 'dedh hazar': 1500, 'डेढ़ सौ': 150, 'डेढ़ हज़ार': 1500,
  // "dhai" prefix = 2.5x  
  'dhai sau': 250, 'dhai hazaar': 2500, 'dhai hazar': 2500, 'ढाई सौ': 250, 'ढाई हज़ार': 2500,
  // "sawa" prefix = 1.25x
  'sawa sau': 125, 'sawa do sau': 225, 'sawa teen sau': 325,
  'sawa hazaar': 1250, 'sawa hazar': 1250, 'सवा सौ': 125,
  // "paune" prefix = 0.75x
  'paune do sau': 175, 'paune teen sau': 275, 'paune char sau': 375,
  'paune do hazaar': 1750, 'paune do hazar': 1750, 'पौने दो सौ': 175,

  // Common fixed amounts
  'ek rupya': 1, 'do rupay': 2, 'das rupay': 10,
  'sau rupay': 100, 'hazaar rupay': 1000
};

/**
 * Parse Hindi/Hinglish/English number words in a text string
 * Returns the text with number words replaced by digits
 */
export function parseHindiNumbers(text) {
  if (!text) return text;
  
  let result = text.trim();

  // Convert Devanagari digits to ASCII digits
  for (const [dev, ascii] of Object.entries(DEVANAGARI_DIGITS)) {
    result = result.replaceAll(dev, ascii);
  }

  // Handle hyphenated numbers like "three-forty"
  result = result.replace(/(\w+)-(\w+)/g, (match, p1, p2) => {
    const combined = `${p1.toLowerCase()}-${p2.toLowerCase()}`;
    if (SPECIAL_NUMBERS[combined]) {
      return String(SPECIAL_NUMBERS[combined]);
    }
    const spaced = `${p1.toLowerCase()} ${p2.toLowerCase()}`;
    if (SPECIAL_NUMBERS[spaced]) {
      return String(SPECIAL_NUMBERS[spaced]);
    }
    return match;
  });

  // Check special composite numbers
  for (const [phrase, value] of Object.entries(SPECIAL_NUMBERS)) {
    const regex = new RegExp(`\\b${escapeRegExp(phrase)}\\b`, 'gi');
    result = result.replace(regex, String(value));
  }

  // Parse remaining compound numbers (e.g., "teen sau chaalis" = 340)
  result = parseCompoundNumber(result);

  return result;
}

function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Parse compound numbers like "teen sau chaalis" → 340, "three hundred forty" -> 340
 */
function parseCompoundNumber(text) {
  const words = text.split(/\s+/);
  const result = [];
  let i = 0;

  while (i < words.length) {
    const numResult = tryParseNumber(words, i);
    if (numResult) {
      result.push(String(numResult.value));
      i = numResult.nextIndex;
    } else {
      result.push(words[i]);
      i++;
    }
  }

  return result.join(' ');
}

/**
 * Try to parse a number starting at word index
 */
function tryParseNumber(words, startIdx) {
  let total = 0;
  let current = 0;
  let foundNumber = false;
  let i = startIdx;

  while (i < words.length) {
    const rawWord = words[i].replace(/[,.]/g, '').toLowerCase();

    // Check if it's already a digit string
    if (/^\d+$/.test(rawWord)) {
      current = parseInt(rawWord, 10);
      foundNumber = true;
      i++;
      
      // Check if next word is a multiplier (e.g. "300 hazaar" or "5 sau")
      if (i < words.length) {
        const nextWord = words[i].replace(/[,.]/g, '').toLowerCase();
        if (HINDI_MULTIPLIERS[nextWord]) {
          current *= HINDI_MULTIPLIERS[nextWord];
          i++;
        }
      }
      total += current;
      current = 0;
      continue;
    }

    // Check units / tens
    if (HINDI_UNITS[rawWord] !== undefined) {
      // Disambiguate Hindi imperative verb auxiliary "do" (e.g. "kar do", "likh do", "bata do")
      if (rawWord === 'do' && startIdx > 0) {
        const prev = words[startIdx - 1].replace(/[,.]/g, '').toLowerCase();
        if (['kar', 'likh', 'bata', 'de', 'hata', 'bhejo', 'daal'].includes(prev)) {
          break;
        }
      }
      current = HINDI_UNITS[rawWord];
      foundNumber = true;
      i++;

      // Check if followed by multiplier (e.g. "teen sau" -> 3 * 100)
      if (i < words.length) {
        const nextWord = words[i].replace(/[,.]/g, '').toLowerCase();
        if (HINDI_MULTIPLIERS[nextWord]) {
          current *= HINDI_MULTIPLIERS[nextWord];
          i++;
        }
      }
      total += current;
      current = 0;
      continue;
    }

    // Multiplier alone (e.g. "sau rupay" -> 100)
    if (HINDI_MULTIPLIERS[rawWord] && !foundNumber) {
      total += HINDI_MULTIPLIERS[rawWord];
      foundNumber = true;
      i++;
      continue;
    }

    break;
  }

  if (foundNumber && total > 0) {
    return { value: total, nextIndex: i };
  }

  return null;
}

/**
 * Extract all numbers from text (both digit and word form)
 */
export function extractNumbers(text) {
  const numbers = [];
  const normalized = parseHindiNumbers(text);
  const digitMatches = normalized.match(/\d+(?:\.\d+)?/g);
  if (digitMatches) {
    for (const m of digitMatches) {
      numbers.push({ value: parseFloat(m), original: m });
    }
  }
  return numbers;
}
