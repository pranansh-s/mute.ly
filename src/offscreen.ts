/**
 * Mute.ly Offscreen Audio Decoder
 * 
 * Listens for messages via chrome.runtime.onMessage (from background relay).
 * Sends results back via chrome.runtime.sendMessage (with _fromOffscreen flag).
 */

import type { OffscreenCommand, OffscreenEvent } from './core/types';
import { AotStreamDecoder, type TranscribeAOTRequest } from './core/audio/aot-stream-decoder';

const worker = new Worker('whisper-worker.js', { type: 'module' });

function send(msg: OffscreenEvent) {
  chrome.runtime.sendMessage({ ...msg, _fromOffscreen: true }).catch(() => {});
}

let workerBusy = false;
let pendingTranscribeQueue: any[] = [];

worker.onmessage = (e) => {
  if (e.data.type === 'result') {
    workerBusy = false;
    send(e.data);
    if (pendingTranscribeQueue.length > 0) {
      const req = pendingTranscribeQueue.shift();
      workerBusy = true;
      worker.postMessage(req);
    }
  } else {
    send(e.data);
  }
};
worker.onerror = (e) => {
  console.error('[Offscreen] Worker error:', e);
  send({ type: 'error', message: 'Worker crash' });
};

const decoder = new AotStreamDecoder(
  (bufferedSeconds) => send({ type: 'aot_buffer_progress', bufferedSeconds }),
  (duration) => send({ type: 'aot_audio_ready', duration }),
  (message) => send({ type: 'error', message }),
  (audio, request) => {
    const req = {
      type: 'transcribe',
      audio,
      id: request.id,
      return_timestamps: request.return_timestamps
    };
    if (workerBusy) {
      pendingTranscribeQueue.push(req);
    } else {
      workerBusy = true;
      worker.postMessage(req);
    }
  },
  (id) => send({ type: 'result', id, result: { text: '' } })
);

chrome.runtime.onMessage.addListener((msg: OffscreenCommand & { _fromBackground?: boolean }) => {
  if (!msg._fromBackground) return;

  switch (msg.type) {
    case 'load':
      console.log('[Offscreen] Loading model...');
      worker.postMessage({ type: 'load' });
      break;
    case 'cancel_requests': {
      const cancelSet = new Set(msg.ids);
      
      // Filter out cancelled requests from the queue and send dropped results
      const newQueue = [];
      for (const pending of pendingTranscribeQueue) {
        if (cancelSet.has(pending.id)) {
          send({ type: 'result', id: pending.id, tabId: pending.tabId, result: { dropped: true } });
        } else {
          newQueue.push(pending);
        }
      }
      pendingTranscribeQueue = newQueue;

      for (const id of msg.ids) {
        worker.postMessage({ type: 'abort_chunk', id });
      }
      break;
    }
    case 'load_aot':
      // Cancel old stream and flush stale worker state from previous session
      decoder.cancelStream();
      pendingTranscribeQueue = [];
      workerBusy = false;
      decoder.loadStream(msg.url);
      break;
    case 'transcribe_aot':
      decoder.transcribeSlice(msg as unknown as TranscribeAOTRequest);
      break;
    case 'transcribe':
      if (workerBusy) {
        pendingTranscribeQueue.push(msg);
      } else {
        workerBusy = true;
        worker.postMessage(msg);
      }
      break;
  }
});

console.log('[Offscreen] Decoder initialized.');
