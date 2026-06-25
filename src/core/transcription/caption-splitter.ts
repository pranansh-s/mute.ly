export interface WordTimestamp {
  text: string;
  start: number;
  end: number;
}

export interface SplitCaption {
  start: number;
  end: number;
  text: string;
}

const PAUSE_GAP_SECONDS = 0.4;
const SENTENCE_END = /[.!?]["')\]]?$/;
const MAX_LINE_CHARS = 42;
const MAX_LINES = 2;
const MAX_CAPTION_CHARS = MAX_LINE_CHARS * MAX_LINES;
const MIN_CAPTION_SECONDS = 0.75;
const READING_SECONDS_PER_CHAR = 0.06;
const MAX_READING_SECONDS_PER_CHAR = 1 / 21;

export function splitCaptionFromWords(words: WordTimestamp[]): SplitCaption[] {
  const usable = sanitizeWords(words);
  if (usable.length === 0) return [];

  const captions: SplitCaption[] = [];
  let current: WordTimestamp[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    for (const caption of layoutBlock(current)) captions.push(caption);
    current = [];
    currentChars = 0;
  };

  for (let i = 0; i < usable.length; i++) {
    const word = usable[i];
    const prev = i > 0 ? usable[i - 1] : null;
    const addedChars = currentChars === 0 ? word.text.length : currentChars + 1 + word.text.length;

    const longPause = prev && word.start - prev.end > PAUSE_GAP_SECONDS;
    const overflows = addedChars > MAX_CAPTION_CHARS;
    const sentenceBreak = prev && SENTENCE_END.test(prev.text) && currentChars >= MAX_LINE_CHARS;

    if (longPause || overflows || sentenceBreak) flush();

    current.push(word);
    currentChars = current.length === 1 ? word.text.length : currentChars + 1 + word.text.length;
  }
  flush();

  return enforceReadingRate(captions);
}

export function splitCaptionFromText(text: string, start: number, end: number): SplitCaption[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  const blocks = splitByPunctuation(trimmed);
  const captions: SplitCaption[] = [];
  const totalChars = blocks.reduce((sum, b) => sum + b.length, 0) || 1;
  const span = Math.max(end - start, MIN_CAPTION_SECONDS);
  let cursor = start;

  for (const block of blocks) {
    const blockSpan = (block.length / totalChars) * span;
    const blockEnd = Math.min(cursor + blockSpan, end);
    for (const line of layoutText(block)) {
      const lineSpan = (line.length / block.length) * blockSpan;
      const lineEnd = Math.min(cursor + lineSpan, blockEnd);
      captions.push({ start: cursor, end: lineEnd, text: line });
      cursor = lineEnd;
    }
    cursor = blockEnd;
  }

  return enforceReadingRate(captions);
}

function sanitizeWords(words: WordTimestamp[]): WordTimestamp[] {
  const out: WordTimestamp[] = [];
  for (const w of words) {
    const text = (w?.text ?? '').trim();
    if (!text) continue;
    if (!Number.isFinite(w.start) || !Number.isFinite(w.end)) continue;
    const end = Math.max(w.end, w.start);
    out.push({ text, start: w.start, end });
  }
  return out;
}

function layoutBlock(words: WordTimestamp[]): SplitCaption[] {
  const lines = wrapWordsToLines(words);
  if (lines.length === 0) return [];

  const captions: SplitCaption[] = [];
  for (let i = 0; i < lines.length; i += MAX_LINES) {
    const group = lines.slice(i, i + MAX_LINES);
    const flat = group.flat();
    captions.push({
      start: flat[0].start,
      end: flat[flat.length - 1].end,
      text: group.map(line => line.map(w => w.text).join(' ')).join('\n'),
    });
  }
  return captions;
}

function wrapWordsToLines(words: WordTimestamp[]): WordTimestamp[][] {
  const lines: WordTimestamp[][] = [];
  let line: WordTimestamp[] = [];
  let lineChars = 0;
  for (const word of words) {
    const added = lineChars === 0 ? word.text.length : lineChars + 1 + word.text.length;
    if (added > MAX_LINE_CHARS && line.length > 0) {
      lines.push(line);
      line = [word];
      lineChars = word.text.length;
    } else {
      line.push(word);
      lineChars = added;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

function splitByPunctuation(text: string): string[] {
  const parts = text.match(/[^.!?]+[.!?]+["')\]]?\s*/g);
  if (!parts) return [text];
  const cleaned = parts.map(p => p.trim()).filter(Boolean);
  return cleaned.length ? cleaned : [text];
}

function layoutText(block: string): string[] {
  const words = block.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? line + ' ' + word : word;
    if (candidate.length > MAX_LINE_CHARS && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);

  const captions: string[] = [];
  for (let i = 0; i < lines.length; i += MAX_LINES) {
    captions.push(lines.slice(i, i + MAX_LINES).join('\n'));
  }
  return captions;
}

function enforceReadingRate(captions: SplitCaption[]): SplitCaption[] {
  const out: SplitCaption[] = [];
  for (let i = 0; i < captions.length; i++) {
    const cur = captions[i];
    const visibleChars = cur.text.replace(/\s+/g, '').length || 1;
    const minDuration = Math.max(MIN_CAPTION_SECONDS, visibleChars * MAX_READING_SECONDS_PER_CHAR);
    const idealDuration = Math.max(minDuration, visibleChars * READING_SECONDS_PER_CHAR);
    const nextStart = captions[i + 1]?.start ?? Infinity;
    const desiredEnd = cur.start + idealDuration;
    const end = Math.min(Math.max(cur.end, desiredEnd), nextStart);
    if (end > cur.start) out.push({ start: cur.start, end, text: cur.text });
  }
  return out;
}
