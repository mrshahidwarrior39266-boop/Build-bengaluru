/**
 * Speech guard: every spoken line passes through here.
 *
 * The track rules are hard constraints, not prompt suggestions:
 *   - no pressure or threat language in anything the agent says
 *   - no lending / credit pushing
 *   - no medical advice
 *
 * A prompt can be jail-broken; a filter on the way out cannot.
 */

const BANNED_PATTERNS = [
  /\bturant\b/gi,
  /\bwarna\b/gi,
  /\bwarn\b/gi,
  /\botherwise\b/gi,
  /\bthreat/gi,
  /\bblacklist/gi,
  /\bpolice\b/gi,
  /\bkanooni\b/gi,
  /\blegal\s+action/gi,
  /\bkarza\b/gi,
  /\bbyaj\b/gi,
  /\binterest\b/gi,
  /\bloan\b/gi,
  /\bdawa\b/gi,
  /\bdose\b/gi,
  /\bdosage\b/gi,
  /\bilaaj\b/gi,
  /\bchuka\s*do\b/gi,
  /\bchaiye\b/gi,
  /\bzaroori\s+hai\b/gi,
  /\bsharma\s*aao\s*gi\?/gi,
  /\bdefaulter\b/gi,
];

const SAFE_FALLBACK = 'Theek hai. Agli baat boliye.';

/** Replace any banned phrase with neutral wording. */
export function safeSpeech(text) {
  if (!text) return '';
  let out = String(text);
  for (const pattern of BANNED_PATTERNS) {
    out = out.replace(pattern, '');
  }
  out = out.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
  if (!out) return SAFE_FALLBACK;
  return out;
}

/** True when a line is free of pressure/medical/lending language. */
export function isCompliantSpeech(text) {
  const value = String(text || '');
  return !BANNED_PATTERNS.some((pattern) => pattern.test(value));
}

export const _internals = { BANNED_PATTERNS };
