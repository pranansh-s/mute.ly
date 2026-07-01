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
  const lower = text.toLowerCase().trim();
  if (!lower || lower.length < 2) return true;

  if (HALLUCINATION_PATTERNS.some(p => p.test(lower))) return true;
  const stripped = lower.replace(/[.!?,]+$/, '');
  if (PHANTOM_TEXTS.has(stripped)) return true;

  const words = lower.replace(/[.!?,]/g, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;

  if (words.length >= 3 && hasRunCollapse(words)) return true;
  if (words.length >= 4 && hasBigramLoop(words)) return true;
  if (words.length >= 4) {
    const unique = new Set(words);
    if (unique.size <= Math.ceil(words.length * 0.3)) return true;
  }

  return false;
}

function hasRunCollapse(words: string[]): boolean {
  let run = 1;
  for (let i = 1; i < words.length; i++) {
    run = words[i] === words[i - 1] ? run + 1 : 1;
    if (run >= 3) return true;
  }
  return false;
}

function hasBigramLoop(words: string[]): boolean {
  const counts = new Map<string, number>();
  for (let i = 0; i < words.length - 1; i++) {
    const bg = words[i] + ' ' + words[i + 1];
    const c = (counts.get(bg) ?? 0) + 1;
    if (c >= 3) return true;
    counts.set(bg, c);
  }
  return false;
}
