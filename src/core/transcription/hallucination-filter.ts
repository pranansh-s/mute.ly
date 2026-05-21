const HALLUCINATION_PATTERNS = [/^\[.*\]$/, /^\(.*\)$/, /^\*.*\*$/];

const PHANTOM_TEXTS = new Set([
  'thank you.', 'thanks for watching.', 'subscribe.',
  'thank you', 'thanks for watching', 'subscribe',
  'like and subscribe', 'see you next time', 'bye',
  'you', 'the end', 'so', 'um', 'uh',
  'thank you for watching', 'please subscribe',
  'music', '♪', 'applause', 'laughter',
]);

/**
 * Evaluates whether a given string is likely an AI hallucination
 * rather than actual spoken text.
 */
export function isHallucination(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (!lower || lower.length < 2) return true;
  
  if (HALLUCINATION_PATTERNS.some(p => p.test(lower))) return true;
  if (PHANTOM_TEXTS.has(lower)) return true;

  const words = lower.split(/\s+/);
  if (words.length >= 4) {
    const unique = new Set(words);
    // If more than 70% of the text is repeated words, it's likely a hallucination loop.
    if (unique.size <= Math.ceil(words.length * 0.3)) return true;
  }

  return false;
}
