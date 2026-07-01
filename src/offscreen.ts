import type {
  AsrDevice,
  AsrMode,
  OffscreenCommand,
  OffscreenEvent,
} from './core/types';
import { AotStreamDecoder, type TranscribeAOTRequest } from './core/audio/aot-stream-decoder';
import { preprocessAudio } from './core/audio/audio-preprocessor';

type RoutedCommand = OffscreenCommand & {
  _fromBackground?: boolean;
  tabId?: number;
};

interface AotOwner {
  clientId?: string;
  tabId?: number;
}

interface WorkerJob {
  kind: 'transcribe_aot' | 'transcribe_live';
  audio: Float32Array | number[];
  id: number;
  sessionId?: number;
  clientId?: string;
  tabId?: number;
  mode: AsrMode;
}

type ModelState = 'idle' | 'loading' | 'ready';
interface ModelStatusState {
  state: ModelState;
  progress: number;
  watchdog: ReturnType<typeof setTimeout> | null;
}

const MODEL_LOAD_STALL_MS = 300_000;
const LIVE_WORKER_TIMEOUT_MS = 20_000;
const AOT_WORKER_TIMEOUT_MS = 330_000;

let worker = createWorker();
let currentDevice: AsrDevice | null = null;
let activeWorkerJob: WorkerJob | null = null;
let activeWorkerJobWatchdog: ReturnType<typeof setTimeout> | null = null;
let workerQueue: WorkerJob[] = [];
let activeAotOwner: AotOwner | null = null;
const modelStates = new Map<AsrMode, ModelStatusState>();

keepOffscreenAlive();

const decoder = new AotStreamDecoder(
  (bufferedSeconds) => send(ownerEvent({ type: 'aot_buffer_progress', bufferedSeconds })),
  (duration) => send(ownerEvent({ type: 'aot_audio_ready', duration })),
  (message) => send(ownerEvent({ type: 'error', message })),
  (audio, request) => enqueueWorkerJob({
    kind: 'transcribe_aot',
    audio,
    id: request.id,
    tabId: request.tabId ?? activeAotOwner?.tabId,
    clientId: request.clientId ?? activeAotOwner?.clientId,
    mode: request.mode,
  }),
  (request) => {
    send({
      type: 'result',
      id: request.id,
      tabId: request.tabId ?? activeAotOwner?.tabId,
      clientId: request.clientId ?? activeAotOwner?.clientId,
      result: { text: '' },
    });
  },
  (request) => {
    send({
      type: 'result',
      id: request.id,
      tabId: request.tabId ?? activeAotOwner?.tabId,
      clientId: request.clientId ?? activeAotOwner?.clientId,
      result: { dropped: true, dropReason: 'audio-unavailable' },
    });
  }
);

chrome.runtime.onMessage.addListener((msg: RoutedCommand) => {
  if (!msg._fromBackground) return;

  switch (msg.type) {
    case 'load':
      requestModelLoad(msg.mode);
      break;
    case 'load_aot':
      stopAotForClient();
      activeAotOwner = { tabId: msg.tabId, clientId: msg.clientId };
      decoder.beginStream();
      break;
    case 'stop_aot':
      stopAotForClient(msg.clientId);
      break;
    case 'aot_pcm':
      if (activeAotOwner && msg.clientId === activeAotOwner.clientId) {
        decoder.feed(decodeBase64(msg.chunk));
      }
      break;
    case 'aot_pcm_end':
      if (activeAotOwner && (!msg.clientId || msg.clientId === activeAotOwner.clientId)) {
        decoder.finalizeStream(msg.durationSeconds);
      }
      break;
    case 'aot_pcm_error':
      if (activeAotOwner && (!msg.clientId || msg.clientId === activeAotOwner.clientId)) {
        decoder.failStream(msg.reason);
      }
      break;
    case 'abort_job':
      abortJob(msg.id, msg.clientId);
      break;
    case 'transcribe_aot':
      if (msg.clientId !== activeAotOwner?.clientId) {
        sendDropped({
          kind: 'transcribe_aot',
          audio: [],
          id: msg.id,
          tabId: msg.tabId,
          clientId: msg.clientId,
          mode: msg.mode,
        });
        break;
      }
      decoder.transcribeSlice(msg as unknown as TranscribeAOTRequest);
      break;
    case 'transcribe_live': {
      const floatAudio = new Float32Array(msg.audio);
      preprocessAudio(floatAudio);
      enqueueWorkerJob({
        kind: 'transcribe_live',
        audio: Array.from(floatAudio),
        id: msg.id,
        sessionId: msg.sessionId,
        tabId: msg.tabId,
        clientId: msg.clientId,
        mode: msg.mode,
      });
      break;
    }
  }
});

function createWorker() {
  const nextWorker = new Worker('asr-worker.js', { type: 'module' });
  nextWorker.onmessage = handleWorkerMessage;
  nextWorker.onerror = handleWorkerError;
  return nextWorker;
}

function handleWorkerMessage(e: MessageEvent<OffscreenEvent>) {
  const msg = e.data;

  if (msg.type === 'device') {
    currentDevice = msg.device;
    send(msg);
    return;
  }

  if (msg.type !== 'result') {
    updateModelStateFromWorker(msg);
    send(msg);
    return;
  }

  const finishedJob = activeWorkerJob;
  activeWorkerJob = null;
  clearActiveWorkerJobWatchdog();

  send({
    ...msg,
    tabId: msg.tabId ?? finishedJob?.tabId,
    clientId: msg.clientId ?? finishedJob?.clientId,
    sessionId: msg.sessionId ?? finishedJob?.sessionId,
  });

  pumpWorkerQueue();
}

function handleWorkerError(e: ErrorEvent) {
  console.error('[mutely:offscreen] Worker error:', e);
  send({
    type: 'error',
    message: 'Worker crash',
    tabId: activeWorkerJob?.tabId,
    clientId: activeWorkerJob?.clientId,
  });
  restartWorker('worker-error');
}

function requestModelLoad(mode: AsrMode) {
  const modelStatus = getModelStatus(mode);

  if (modelStatus.state === 'ready') {
    send({ type: 'ready', mode, device: currentDevice ?? undefined });
    return;
  }

  if (modelStatus.state === 'loading') {
    send({ type: 'loading', progress: modelStatus.progress, mode });
    armModelLoadWatchdog(mode);
    return;
  }

  modelStatus.state = 'loading';
  modelStatus.progress = 0;
  armModelLoadWatchdog(mode);
  worker.postMessage({ type: 'load', mode });
}

function updateModelStateFromWorker(msg: OffscreenEvent) {
  if (msg.type !== 'loading' && msg.type !== 'ready' && msg.type !== 'error') return;

  const mode = ('mode' in msg && msg.mode ? msg.mode : 'vod') as AsrMode;
  const modelStatus = getModelStatus(mode);

  switch (msg.type) {
    case 'loading':
      modelStatus.state = 'loading';
      modelStatus.progress = msg.progress;
      armModelLoadWatchdog(mode);
      break;
    case 'ready':
      modelStatus.state = 'ready';
      modelStatus.progress = 100;
      clearModelLoadWatchdog(mode);
      break;
    case 'error':
      modelStatus.state = 'idle';
      clearModelLoadWatchdog(mode);
      break;
  }
}

function armModelLoadWatchdog(mode: AsrMode) {
  clearModelLoadWatchdog(mode);
  const modelStatus = getModelStatus(mode);

  modelStatus.watchdog = setTimeout(() => {
    if (modelStatus.state !== 'loading') return;
    console.error('[mutely:offscreen] Model load stalled; restarting ASR worker.');
    send({ type: 'error', message: 'Model load stalled. Please try again.', mode });
    restartWorker('model-load-stalled');
  }, MODEL_LOAD_STALL_MS);
}

function clearModelLoadWatchdog(mode: AsrMode) {
  const modelStatus = getModelStatus(mode);
  if (!modelStatus.watchdog) return;
  clearTimeout(modelStatus.watchdog);
  modelStatus.watchdog = null;
}

function restartWorker(reason: string, preserveQueuedJobs = false) {
  console.warn(`[mutely:offscreen] Restarting ASR worker: ${reason}`);
  clearActiveWorkerJobWatchdog();

  if (preserveQueuedJobs) {
    if (activeWorkerJob) {
      sendDropped(activeWorkerJob);
      activeWorkerJob = null;
    }
    for (const modelStatus of modelStates.values()) {
      if (modelStatus.watchdog) clearTimeout(modelStatus.watchdog);
      modelStatus.state = 'idle';
      modelStatus.progress = 0;
      modelStatus.watchdog = null;
    }
  } else {
    for (const modelStatus of modelStates.values()) {
      if (modelStatus.watchdog) clearTimeout(modelStatus.watchdog);
    }
    modelStates.clear();
    currentDevice = null;
    dropWorkerJobs();
  }

  worker.terminate();
  worker = createWorker();
  if (preserveQueuedJobs) pumpWorkerQueue();
}

function getModelStatus(mode: AsrMode) {
  let modelStatus = modelStates.get(mode);
  if (!modelStatus) {
    modelStatus = { state: 'idle', progress: 0, watchdog: null };
    modelStates.set(mode, modelStatus);
  }
  return modelStatus;
}

function enqueueWorkerJob(job: WorkerJob) {
  workerQueue.push(job);
  pumpWorkerQueue();
}

function pumpWorkerQueue() {
  if (activeWorkerJob || workerQueue.length === 0) return;

  const job = workerQueue.shift()!;
  activeWorkerJob = job;
  armActiveWorkerJobWatchdog(job);

  worker.postMessage({
    type: job.kind,
    audio: job.audio,
    id: job.id,
    sessionId: job.sessionId,
    tabId: job.tabId,
    clientId: job.clientId,
    mode: job.mode,
  });
}

function armActiveWorkerJobWatchdog(job: WorkerJob) {
  clearActiveWorkerJobWatchdog();
  const timeoutMs = job.kind === 'transcribe_live' ? LIVE_WORKER_TIMEOUT_MS : AOT_WORKER_TIMEOUT_MS;

  activeWorkerJobWatchdog = setTimeout(() => {
    if (activeWorkerJob?.id !== job.id) return;
    sendDropped(job);
    activeWorkerJob = null;
    restartWorker(`${job.kind}-timeout`);
    pumpWorkerQueue();
  }, timeoutMs);
}

function clearActiveWorkerJobWatchdog() {
  if (!activeWorkerJobWatchdog) return;
  clearTimeout(activeWorkerJobWatchdog);
  activeWorkerJobWatchdog = null;
}

function stopAotForClient(clientId?: string) {
  if (!clientId || activeAotOwner?.clientId === clientId) {
    decoder.cancelStream();
    activeAotOwner = null;
  }

  dropQueuedAotJobs(clientId);
  abortActiveAotJob(clientId);
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function abortActiveAotJob(clientId?: string) {
  if (
    activeWorkerJob?.kind === 'transcribe_aot' &&
    (!clientId || activeWorkerJob.clientId === clientId)
  ) {
    worker.postMessage({ type: 'abort_chunk', id: activeWorkerJob.id });
  }
}

function abortJob(id: number, clientId: string) {
  if (activeWorkerJob?.id === id && activeWorkerJob.clientId === clientId) {
    worker.postMessage({ type: 'abort_chunk', id });
    return;
  }

  const remainingQueue: WorkerJob[] = [];
  for (const job of workerQueue) {
    if (job.id === id && job.clientId === clientId) {
      sendDropped(job);
    } else {
      remainingQueue.push(job);
    }
  }
  workerQueue = remainingQueue;
}

function dropQueuedAotJobs(clientId?: string) {
  const remainingQueue: WorkerJob[] = [];

  for (const job of workerQueue) {
    if (job.kind === 'transcribe_aot' && (!clientId || job.clientId === clientId)) {
      sendDropped(job);
    } else {
      remainingQueue.push(job);
    }
  }

  workerQueue = remainingQueue;
}

function dropWorkerJobs() {
  if (activeWorkerJob) {
    sendDropped(activeWorkerJob);
    activeWorkerJob = null;
  }

  for (const job of workerQueue) sendDropped(job);
  workerQueue = [];
}

function sendDropped(job: WorkerJob) {
  send({
    type: 'result',
    id: job.id,
    sessionId: job.sessionId,
    tabId: job.tabId,
    clientId: job.clientId,
    result: { dropped: true, dropReason: 'offscreen-dropped' },
  });
}

function send(msg: OffscreenEvent) {
  chrome.runtime.sendMessage({ ...msg, _fromOffscreen: true }).catch(err => {
    console.warn('[mutely:offscreen] sendMessage failed:', err);
  });
}

function ownerEvent<T extends OffscreenEvent>(msg: T): T {
  const routedMsg = msg as T & AotOwner;
  return {
    ...msg,
    tabId: routedMsg.tabId ?? activeAotOwner?.tabId,
    clientId: routedMsg.clientId ?? activeAotOwner?.clientId,
  } as T;
}

function keepOffscreenAlive() {
  try {
    const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    const osc = ctx.createOscillator();
    const gainNode = ctx.createGain();

    osc.type = 'sine';
    osc.frequency.setValueAtTime(1, ctx.currentTime);
    gainNode.gain.setValueAtTime(0.001, ctx.currentTime);

    osc.connect(gainNode);
    gainNode.connect(ctx.destination);
    osc.start();
  } catch (err) {
    console.warn('[mutely:offscreen] Failed to start silent keep-alive loop:', err);
  }
}
