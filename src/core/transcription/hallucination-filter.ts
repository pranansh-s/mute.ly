const PATTERN_WRAPPED = [/^\[.*\]$/, /^\(.*\)$/, /^\*.*\*$/];

const PHANTOM_TEXTS = new Set([
  'thanks for watching', 'thanks for watching.',
  'thank you for watching', 'thank you for watching.',
  'please subscribe', 'like and subscribe',
  'see you next time', 'see you in the next video',
  '♪', '[music]', '[applause]', '[laughter]',
]);

const REPEAT_RUN_MIN = 3;
const PHRASE_LOOP_MIN_REPEATS = 3;
const PHRASE_LOOP_MAX_WORDS = 4;
const LOW_UNIQUENESS_MIN_WORDS = 4;
const LOW_UNIQUENESS_RATIO = 0.3;

export function cleanHallucinations(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  if (isWrappedNonSpeech(trimmed)) return '';
  if (PHANTOM_TEXTS.has(trimmed.toLowerCase())) return '';

  const tokens = tokenize(trimmed);
  if (tokens.length === 0) return '';

  const noRuns = collapseRuns(tokens);
  const noLoops = collapsePhraseLoops(noRuns);
  if (!hasEnoughDiversity(noLoops)) return '';

  const rebuilt = rebuild(noLoops);
  if (!rebuilt) return '';
  if (PHANTOM_TEXTS.has(rebuilt.toLowerCase())) return '';
  return rebuilt;
}

export function isHallucination(text: string): boolean {
  return cleanHallucinations(text) === '';
}

interface Token {
  raw: string;
  key: string;
  leadingSpace: boolean;
}

function tokenize(text: string): Token[] {
  const matches = text.match(/\s*\S+/g);
  if (!matches) return [];
  return matches.map(raw => ({
    raw: raw.replace(/^\s+/, ''),
    key: raw.toLowerCase().replace(/[^a-z0-9']/g, ''),
    leadingSpace: /^\s/.test(raw),
  }));
}

function collapseRuns(tokens: Token[]): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    let runEnd = i + 1;
    while (runEnd < tokens.length && tokens[runEnd].key === tokens[i].key && tokens[i].key !== '') {
      runEnd++;
    }
    out.push(tokens[i]);
    if (runEnd - i < REPEAT_RUN_MIN) {
      for (let k = i + 1; k < runEnd; k++) out.push(tokens[k]);
    }
    i = runEnd;
  }
  return out;
}

function collapsePhraseLoops(tokens: Token[]): Token[] {
  if (tokens.length < PHRASE_LOOP_MIN_REPEATS * 2) return tokens;
  const out: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    let collapsed = false;
    for (let len = PHRASE_LOOP_MAX_WORDS; len >= 2; len--) {
      if (i + len * PHRASE_LOOP_MIN_REPEATS > tokens.length) continue;
      const head = sliceKey(tokens, i, len);
      if (!head) continue;
      let repeats = 1;
      while (
        i + (repeats + 1) * len <= tokens.length &&
        sliceKey(tokens, i + repeats * len, len) === head
      ) {
        repeats++;
      }
      if (repeats >= PHRASE_LOOP_MIN_REPEATS) {
        for (let k = i; k < i + len; k++) out.push(tokens[k]);
        i += repeats * len;
        collapsed = true;
        break;
      }
    }
    if (!collapsed) {
      out.push(tokens[i]);
      i++;
    }
  }
  return out;
}

function sliceKey(tokens: Token[], start: number, len: number): string {
  const parts: string[] = [];
  for (let k = start; k < start + len; k++) {
    if (!tokens[k].key) return '';
    parts.push(tokens[k].key);
  }
  return parts.join(' ');
}

function hasEnoughDiversity(tokens: Token[]): boolean {
  if (tokens.length < LOW_UNIQUENESS_MIN_WORDS) return true;
  const unique = new Set(tokens.map(t => t.key).filter(Boolean));
  return unique.size > Math.ceil(tokens.length * LOW_UNIQUENESS_RATIO);
}

function rebuild(tokens: Token[]): string {
  let out = '';
  for (let i = 0; i < tokens.length; i++) {
    if (i > 0 && tokens[i].leadingSpace) out += ' ';
    out += tokens[i].raw;
  }
  return out.trim();
}

function isWrappedNonSpeech(text: string): boolean {
  return PATTERN_WRAPPED.some(p => p.test(text));
}
