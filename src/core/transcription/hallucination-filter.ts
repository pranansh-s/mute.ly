const HALLUCINATION_PATTERNS = [/^\[.*\]$/, /^\(.*\)$/, /^\*.*\*$/];

const PHANTOM_TEXTS = new Set([
  'thank you', 'thanks for watching', 'subscribe',
  'like and subscribe', 'see you next time', 'bye',
  'you', 'the end', 'so', 'um', 'uh',
  'thank you for watching', 'please subscribe',
  'music', '♪', 'applause', 'laughter',
]);

export function cleanHallucinations(input: string): string {
  const trimmed = input.trim();
  return isHallucination(trimmed) ? '' : trimmed;
}

export function isHallucination(text: string): boolean {
  const lower = text.toLowerCase();
  if (!lower || lower.length < 2) return true;

  if (HALLUCINATION_PATTERNS.some(p => p.test(lower))) return true;
  const stripped = lower.replace(/[.!?]+$/, '');
  if (PHANTOM_TEXTS.has(stripped)) return true;

  const words = lower.split(/\s+/);
  if (words.length >= 4) {
    const unique = new Set(words);
    if (unique.size <= Math.ceil(words.length * 0.3)) return true;
  }

  return false;
}
