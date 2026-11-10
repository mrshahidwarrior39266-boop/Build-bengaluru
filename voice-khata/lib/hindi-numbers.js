/**
 * Hindi/Hinglish Number Parser
 * Converts spoken number words to digits.
 * Handles: "teen sau chaalis" → 340, "dedh sau" → 150, "sawa sau" → 125
 * 
 * This runs as a pre-processor before sending to LLM to ensure
 * accurate number capture even under noise.
 */

const HINDI_UNITS = {
  'ek': 1, 'do': 2, 'teen': 3, 'char': 4, 'paanch': 5, 'panch': 5,
  'chhah': 6, 'chhe': 6, 'saat': 7, 'aath': 8, 'nau': 9,
  'das': 10, 'gyaarah': 11, 'baarah': 12, 'terah': 13, 'chaudah': 14,
  'pandrah': 15, 'solah': 16, 'satrah': 17, 'athaarah': 18, 'unees': 19,
  'bees': 20, 'ikkees': 21, 'baees': 22, 'teis': 23, 'chaubees': 24,
  'pachees': 25, 'chhabbees': 26, 'sattaees': 27, 'atthaees': 28, 'untees': 29,
  'tees': 30, 'ikattees': 31, 'battees': 32, 'taintees': 33, 'chauntees': 34,
  'paintees': 35, 'chhattees': 36, 'saintees': 37, 'adtees': 38, 'untaalees': 39,
  'chaalees': 40, 'chaalis': 40, 'iktaalees': 41, 'bayaalees': 42, 'taintaalees': 43,
  'chavaalees': 44, 'paintaalees': 45, 'chhiyaalees': 46, 'saintaalees': 47,
  'adtaalees': 48, 'unchaas': 49,
  'pachaas': 50, 'ikyaavan': 51, 'baavan': 52, 'tirpan': 53, 'chauvan': 54,
  'pachpan': 55, 'chhappan': 56, 'sattaavan': 57, 'athaavan': 58, 'unsath': 59,
  'saath': 60, 'iksath': 61, 'baasath': 62, 'tirsath': 63, 'chaunsath': 64,
  'painsath': 65, 'chhiyaasath': 66, 'sadsath': 67, 'adsath': 68, 'unhattar': 69,
  'sattar': 70, 'ikattar': 71, 'bahattar': 72, 'tihattar': 73, 'chauhattar': 74,
  'pachhattar': 75, 'chhi-hattar': 76, 'satattar': 77, 'athhattar': 78, 'unnaasi': 79,
  'assi': 80, 'ikyaasi': 81, 'bayaasi': 82, 'tiraasi': 83, 'chauraasi': 84,
  'pachaasi': 85, 'chhiyaasi': 86, 'sattaasi': 87, 'atthaasi': 88, 'navaasi': 89,
  'nabbe': 90, 'ikyaanve': 91, 'baanve': 92, 'tiraaanve': 93, 'chauraanve': 94,
  'panchaanve': 95, 'chhiyaanve': 96, 'sattaanve': 97, 'atthaanve': 98, 'ninyaanve': 99,
  // Common variations
  'chalis': 40, 'pachas': 50, 'saathi': 60, 'sattar': 70, 'assi': 80, 'nabe': 90,
};

const HINDI_MULTIPLIERS = {
  'sau': 100, 'so': 100,
  'hazaar': 1000, 'hazar': 1000, 'hajaar': 1000,
  'lakh': 100000, 'lac': 100000,
  'crore': 10000000, 'karod': 10000000,
};

const SPECIAL_NUMBERS = {
  // "dedh" prefix = 1.5x
  'dedh sau': 150, 'dedh hazaar': 1500, 'dedh hazar': 1500,
  // "dhai" prefix = 2.5x  
  'dhai sau': 250, 'dhai hazaar': 2500, 'dhai hazar': 2500,
  // "sawa" prefix = 1.25x
  'sawa sau': 125, 'sawa do sau': 225, 'sawa teen sau': 325,
  'sawa hazaar': 1250, 'sawa hazar': 1250,
  // "paune" prefix = 0.75x
  'paune do sau': 175, 'paune teen sau': 275, 'paune char sau': 375,
  'paune do hazaar': 1750, 'paune do hazar': 1750,
  // Common fixed amounts
  'ek rupya': 1, 'do rupay': 2, 'das rupay': 10,
  'sau rupay': 100, 'hazaar rupay': 1000,
};

/**
 * Parse Hindi/Hinglish number words in a text string
 * Returns the text with number words replaced by digits
 */
export function parseHindiNumbers(text) {
  if (!text) return text;
  
  let result = text.toLowerCase().trim();

  // First, check for special composite numbers
  for (const [phrase, value] of Object.entries(SPECIAL_NUMBERS)) {
    const regex = new RegExp(phrase, 'gi');
    if (regex.test(result)) {
      result = result.replace(regex, String(value));
    }
  }

  // Parse remaining compound numbers (e.g., "teen sau chaalis" = 340)
  result = parseCompoundNumber(result);

  return result;
}

/**
 * Parse compound Hindi numbers like "teen sau chaalis" → 340
 */
function parseCompoundNumber(text) {
  const words = text.split(/\s+/);
  const result = [];
  let i = 0;

  while (i < words.length) {
    // Try to parse a number starting at position i
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
 * Returns { value, nextIndex } or null
 */
function tryParseNumber(words, startIdx) {
  let total = 0;
  let current = 0;
  let foundNumber = false;
  let i = startIdx;

  while (i < words.length) {
    const word = words[i].replace(/[,.]/, '');

    // Check if it's a digit string
    if (/^\d+$/.test(word)) {
      current = parseInt(word, 10);
      foundNumber = true;
      i++;
      
      // Check if next word is a multiplier
      if (i < words.length) {
        const nextWord = words[i].replace(/[,.]/, '');
        if (HINDI_MULTIPLIERS[nextWord]) {
          current *= HINDI_MULTIPLIERS[nextWord];
          i++;
        }
      }
      total += current;
      current = 0;
      continue;
    }

    // Check Hindi units
    if (HINDI_UNITS[word] !== undefined) {
      current = HINDI_UNITS[word];
      foundNumber = true;
      i++;

      // Check if next word is a multiplier
      if (i < words.length) {
        const nextWord = words[i].replace(/[,.]/, '');
        if (HINDI_MULTIPLIERS[nextWord]) {
          current *= HINDI_MULTIPLIERS[nextWord];
          i++;
        }
      }
      total += current;
      current = 0;
      continue;
    }

    // Check if it's a multiplier by itself (e.g., "sau" = 100)
    if (HINDI_MULTIPLIERS[word] && !foundNumber) {
      total += HINDI_MULTIPLIERS[word];
      foundNumber = true;
      i++;
      continue;
    }

    // Not a number word, stop
    break;
  }

  if (foundNumber && total > 0) {
    return { value: total, nextIndex: i };
  }

  return null;
}

/**
 * Extract all numbers from text (both digit and word form)
 * Returns array of { value, original }
 */
export function extractNumbers(text) {
  const numbers = [];
  
  // First extract digit numbers
  const digitMatches = text.match(/\d+(?:\.\d+)?/g);
  if (digitMatches) {
    for (const m of digitMatches) {
      numbers.push({ value: parseFloat(m), original: m });
    }
  }

  // Then parse Hindi number words
  const parsed = parseHindiNumbers(text);
  const parsedDigits = parsed.match(/\d+(?:\.\d+)?/g);
  if (parsedDigits) {
    for (const m of parsedDigits) {
      const val = parseFloat(m);
      if (!numbers.find(n => n.value === val)) {
        numbers.push({ value: val, original: m });
      }
    }
  }

  return numbers;
}

// Quick self-test
if (process.argv[1] && process.argv[1].endsWith('hindi-numbers.js')) {
  const tests = [
    ['teen sau chaalis', '340'],
    ['paanch sau', '500'],
    ['ek hazaar', '1000'],
    ['dedh sau', '150'],
    ['dhai sau', '250'],
    ['sawa sau', '125'],
    ['das hazaar', '10000'],
    ['bees', '20'],
    ['pachaas', '50'],
  ];

  console.log('Hindi Number Parser Tests:\n');
  let pass = 0;
  for (const [input, expected] of tests) {
    const result = parseHindiNumbers(input).trim();
    const ok = result === expected;
    console.log(`  ${ok ? '✅' : '❌'} "${input}" → "${result}" (expected: "${expected}")`);
    if (ok) pass++;
  }
  console.log(`\n  ${pass}/${tests.length} passed\n`);
}
