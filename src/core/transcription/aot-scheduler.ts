export const CHUNK_DURATION_SECONDS = 30;
export const CHUNK_STRIDE_SECONDS = 22;
export const LOOKAHEAD_CHUNKS = 4;

export interface ChunkRequest {
  key: string;
  index: number;
  startTime: number;
  endTime: number;
  ownedEnd: number;
}

export function getChunkKey(startTime: number, endTime: number): string {
  return `${Math.round(startTime * 10)}_${Math.round(endTime * 10)}`;
}

export function getChunkIndex(time: number): number {
  return Math.max(0, Math.floor(time / CHUNK_STRIDE_SECONDS));
}

export function getChunkWindow(chunkIndex: number, effectiveDuration: number): ChunkRequest {
  const startTime = chunkIndex * CHUNK_STRIDE_SECONDS;
  const endTime = Math.min(startTime + CHUNK_DURATION_SECONDS, effectiveDuration);
  const ownedEnd = Math.min((chunkIndex + 1) * CHUNK_STRIDE_SECONDS, effectiveDuration);
  return {
    key: getChunkKey(startTime, endTime),
    index: chunkIndex,
    startTime,
    endTime,
    ownedEnd,
  };
}

export function computeNeededChunks(
  currentTime: number,
  playbackRate: number,
  effectiveDuration: number
): ChunkRequest[] {
  const currentChunk = getChunkIndex(currentTime);
  const lastChunk = Number.isFinite(effectiveDuration)
    ? Math.ceil(effectiveDuration / CHUNK_STRIDE_SECONDS) - 1
    : Infinity;
  const lookahead = playbackRate > 1.25 ? LOOKAHEAD_CHUNKS + 1 : LOOKAHEAD_CHUNKS;
  const maxChunk = Math.min(currentChunk + lookahead, lastChunk);

  const out: ChunkRequest[] = [];
  for (let i = currentChunk; i <= maxChunk; i++) {
    if (i < 0) continue;
    out.push(getChunkWindow(i, effectiveDuration));
  }
  return out;
}

export function pickPending(
  needed: ChunkRequest[],
  hasCached: (key: string) => boolean,
  activeKey: string | null,
  bufferedDuration: number
): ChunkRequest[] {
  const pending: ChunkRequest[] = [];
  const seen = new Set<string>();

  for (const chunk of needed) {
    if (seen.has(chunk.key)) continue;
    if (hasCached(chunk.key)) continue;
    if (chunk.key === activeKey) continue;
    if (chunk.endTime > bufferedDuration) continue;
    pending.push(chunk);
    seen.add(chunk.key);
  }
  return pending;
}
