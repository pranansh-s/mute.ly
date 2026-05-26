/**
 * Mute.ly Offscreen Audio Decoder
 *
 * The offscreen document owns the VOD PCM stream and the physical Whisper worker.
 * Scheduling policy stays in the content-side AOT pipeline; this file gates one
 * worker job at a time and routes results back to the originating tab/client.
 */

import type { OffscreenCommand, OffscreenEvent, SpeechActivityWindow, WhisperModelKind } from './core/types';
import { AotStreamDecoder, type TranscribeAOTRequest } from './core/audio/aot-stream-decoder';

type RoutedCommand = OffscreenCommand & {
  _fromBackground?: boolean;
  tabId?: number;
};

interface AotOwner {
  clientId?: string;
  tabId?: number;
}

interface WorkerJob {
  mode: 'aot' | 'jit';
  audio: Float32Array | number[];
  id: number;
  return_timestamps?: boolean;
  clientId?: string;
  tabId?: number;
  speechActivity?: SpeechActivityWindow[];
  modelKind: WhisperModelKind;
}

type ModelState = 'idle' | 'loading' | 'ready';
interface ModelStatusState {
  state: ModelState;
  progress: number;
  watchdog: ReturnType<typeof setTimeout> | null;
}

const MODEL_LOAD_STALL_MS = 300_000;
const JIT_WORKER_TIMEOUT_MS = 20_000;
const AOT_WORKER_TIMEOUT_MS = 330_000;

let worker = createWorker();
let activeWorkerJob: WorkerJob | null = null;
let activeWorkerJobWatchdog: ReturnType<typeof setTimeout> | null = null;
let workerQueue: WorkerJob[] = [];
let activeAotOwner: AotOwner | null = null;
const modelStates = new Map<WhisperModelKind, ModelStatusState>();

const decoder = new AotStreamDecoder(
  (bufferedSeconds) => send(ownerEvent({ type: 'aot_buffer_progress', bufferedSeconds })),
  (duration) => send(ownerEvent({ type: 'aot_audio_ready', duration })),
  (message) => send(ownerEvent({ type: 'error', message })),
  (audio, request) => enqueueWorkerJob({
    mode: 'aot',
    audio,
    id: request.id,
    return_timestamps: request.return_timestamps,
    tabId: request.tabId ?? activeAotOwner?.tabId,
    clientId: request.clientId ?? activeAotOwner?.clientId,
    speechActivity: request.speechActivity,
    modelKind: request.modelKind,
  }),
  (request) => send({
    type: 'result',
    id: request.id,
    tabId: request.tabId ?? activeAotOwner?.tabId,
    clientId: request.clientId ?? activeAotOwner?.clientId,
    result: { text: '' },
  }),
  (request) => send({
    type: 'result',
    id: request.id,
    tabId: request.tabId ?? activeAotOwner?.tabId,
    clientId: request.clientId ?? activeAotOwner?.clientId,
    result: { dropped: true, dropReason: 'audio-unavailable' },
  })
);

chrome.runtime.onMessage.addListener((msg: RoutedCommand) => {
  if (!msg._fromBackground) return;

  switch (msg.type) {
    case 'load':
      requestModelLoad(msg.modelKind);
      break;
    case 'load_aot':
      stopAotForClient();
      activeAotOwner = { tabId: msg.tabId, clientId: msg.clientId };
      decoder.loadStream(msg.url);
      break;
    case 'stop_aot':
      stopAotForClient(msg.clientId);
      break;
    case 'abort_job':
      abortJob(msg.id, msg.clientId);
      break;
    case 'transcribe_aot':
      if (msg.clientId !== activeAotOwner?.clientId) {
        sendDropped({
          mode: 'aot',
          audio: [],
          id: msg.id,
          tabId: msg.tabId,
          clientId: msg.clientId,
          modelKind: msg.modelKind,
        });
        break;
      }
      decoder.transcribeSlice(msg as unknown as TranscribeAOTRequest);
      break;
    case 'transcribe':
      enqueueWorkerJob({
        mode: 'jit',
        audio: msg.audio,
        id: msg.id,
        tabId: msg.tabId,
        clientId: msg.clientId,
        modelKind: msg.modelKind,
      });
      break;
  }
});

function createWorker() {
  const nextWorker = new Worker('whisper-worker.js', { type: 'module' });
  nextWorker.onmessage = handleWorkerMessage;
  nextWorker.onerror = handleWorkerError;
  return nextWorker;
}

function handleWorkerMessage(e: MessageEvent<OffscreenEvent>) {
  const msg = e.data;

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
    result: finishedJob?.speechActivity
      ? { ...msg.result, speechActivity: finishedJob.speechActivity }
      : msg.result,
  });

  pumpWorkerQueue();
}

function handleWorkerError(e: ErrorEvent) {
  console.error('[Offscreen] Worker error:', e);

  send({
    type: 'error',
    message: 'Worker crash',
    tabId: activeWorkerJob?.tabId,
    clientId: activeWorkerJob?.clientId,
  });

  restartWorker('worker-error');
}

function requestModelLoad(modelKind: WhisperModelKind) {
  const modelStatus = getModelStatus(modelKind);

  if (modelStatus.state === 'ready') {
    send({ type: 'ready', modelKind });
    return;
  }

  if (modelStatus.state === 'loading') {
    send({ type: 'loading', progress: modelStatus.progress, modelKind });
    armModelLoadWatchdog(modelKind);
    return;
  }

  modelStatus.state = 'loading';
  modelStatus.progress = 0;
  armModelLoadWatchdog(modelKind);
  worker.postMessage({ type: 'load', modelKind });
}

function updateModelStateFromWorker(msg: OffscreenEvent) {
  if (msg.type !== 'loading' && msg.type !== 'ready' && msg.type !== 'error') return;

  const modelKind = 'modelKind' in msg && msg.modelKind ? msg.modelKind : 'base';
  const modelStatus = getModelStatus(modelKind);

  switch (msg.type) {
    case 'loading':
      modelStatus.state = 'loading';
      modelStatus.progress = msg.progress;
      armModelLoadWatchdog(modelKind);
      break;
    case 'ready':
      modelStatus.state = 'ready';
      modelStatus.progress = 100;
      clearModelLoadWatchdog(modelKind);
      break;
    case 'error':
      modelStatus.state = 'idle';
      clearModelLoadWatchdog(modelKind);
      break;
  }
}

function armModelLoadWatchdog(modelKind: WhisperModelKind) {
  clearModelLoadWatchdog(modelKind);
  const modelStatus = getModelStatus(modelKind);

  modelStatus.watchdog = setTimeout(() => {
    if (modelStatus.state !== 'loading') return;

    console.error('[Offscreen] Model load stalled; restarting Whisper worker.');
    send({ type: 'error', message: 'Model load stalled. Please try again.' });
    restartWorker('model-load-stalled');
  }, MODEL_LOAD_STALL_MS);
}

function clearModelLoadWatchdog(modelKind: WhisperModelKind) {
  const modelStatus = getModelStatus(modelKind);
  if (!modelStatus.watchdog) return;
  clearTimeout(modelStatus.watchdog);
  modelStatus.watchdog = null;
}

function restartWorker(_reason: string) {
  clearActiveWorkerJobWatchdog();
  for (const modelStatus of modelStates.values()) {
    if (modelStatus.watchdog) clearTimeout(modelStatus.watchdog);
  }
  modelStates.clear();
  dropWorkerJobs();
  worker.terminate();
  worker = createWorker();
}

function getModelStatus(modelKind: WhisperModelKind) {
  let modelStatus = modelStates.get(modelKind);
  if (!modelStatus) {
    modelStatus = { state: 'idle', progress: 0, watchdog: null };
    modelStates.set(modelKind, modelStatus);
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
    type: 'transcribe',
    audio: job.audio,
    id: job.id,
    tabId: job.tabId,
    clientId: job.clientId,
    return_timestamps: job.return_timestamps,
    modelKind: job.modelKind,
  });
}

function armActiveWorkerJobWatchdog(job: WorkerJob) {
  clearActiveWorkerJobWatchdog();
  const timeoutMs = job.mode === 'jit' ? JIT_WORKER_TIMEOUT_MS : AOT_WORKER_TIMEOUT_MS;

  activeWorkerJobWatchdog = setTimeout(() => {
    if (activeWorkerJob?.id !== job.id) return;

    sendDropped({ ...job, mode: job.mode });
    activeWorkerJob = null;
    restartWorker(`${job.mode}-job-timeout`);
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

function abortActiveAotJob(clientId?: string) {
  if (
    activeWorkerJob?.mode === 'aot' &&
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
    if (job.mode === 'aot' && (!clientId || job.clientId === clientId)) {
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

  for (const job of workerQueue) {
    sendDropped(job);
  }

  workerQueue = [];
}

function sendDropped(job: WorkerJob) {
  send({
    type: 'result',
    id: job.id,
    tabId: job.tabId,
    clientId: job.clientId,
    result: { dropped: true, dropReason: 'offscreen-dropped' },
  });
}

function send(msg: OffscreenEvent) {
  chrome.runtime.sendMessage({ ...msg, _fromOffscreen: true }).catch(() => {});
}

function ownerEvent<T extends OffscreenEvent>(msg: T): T {
  const routedMsg = msg as T & AotOwner;
  return {
    ...msg,
    tabId: routedMsg.tabId ?? activeAotOwner?.tabId,
    clientId: routedMsg.clientId ?? activeAotOwner?.clientId,
  } as T;
}
