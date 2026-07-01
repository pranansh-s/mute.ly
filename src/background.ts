const NATIVE_HOST_NAME = 'com.mutely.host';
const PROBE_TIMEOUT_MS = 4000;

let creationPromise: Promise<void> | null = null;
const activeTabs = new Set<number>();
const GLOBAL_EVENT_TYPES = new Set(['loading', 'ready', 'error']);

interface AotOwner {
  tabId?: number;
  clientId?: string;
  videoId: string;
}

let nativePort: chrome.runtime.Port | null = null;
let activeAotOwner: AotOwner | null = null;

async function ensureOffscreen() {
  if (creationPromise) return creationPromise;

  creationPromise = (async () => {
    const url = chrome.runtime.getURL('index.html');
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      documentUrls: [url]
    });

    if (existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: 'index.html',
        reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
        justification: 'Whisper transcription'
      });
    }
  })();

  try {
    await creationPromise;
  } finally {
    creationPromise = null;
  }
}

async function forwardToOffscreen(data: Record<string, unknown>, tabId?: number) {
  const payload = { ...data, _fromBackground: true, tabId };
  await ensureOffscreen();
  try {
    await chrome.runtime.sendMessage(payload);
  } catch {
    await ensureOffscreen();
    try { await chrome.runtime.sendMessage(payload); } catch {}
  }
}

function sendToTab(tabId: number | undefined, msg: Record<string, unknown>) {
  if (typeof tabId !== 'number') return;
  chrome.tabs.sendMessage(tabId, { ...msg, _fromOffscreen: true }).catch(() => {
    activeTabs.delete(tabId);
  });
}

function disconnectNativePort() {
  if (!nativePort) return;
  const port = nativePort;
  nativePort = null;
  try { port.postMessage({ type: 'stop' }); } catch {}
  try { port.disconnect(); } catch {}
}

function startNativeStream(videoId: string, tabId: number | undefined, clientId: string) {
  disconnectNativePort();
  activeAotOwner = { tabId, clientId, videoId };

  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void forwardToOffscreen({ type: 'aot_pcm_error', reason: `NO_NATIVE_HOST: ${message}`, clientId });
    activeAotOwner = null;
    return;
  }

  nativePort = port;

  port.onMessage.addListener((msg: { type?: string; chunk?: string; durationSeconds?: number; message?: string; code?: string }) => {
    if (port !== nativePort) return;
    if (!msg || typeof msg.type !== 'string') return;

    const owner = activeAotOwner;
    if (msg.type === 'pcm' && typeof msg.chunk === 'string') {
      void forwardToOffscreen({ type: 'aot_pcm', chunk: msg.chunk, clientId: owner?.clientId }, owner?.tabId);
      return;
    }
    if (msg.type === 'end') {
      void forwardToOffscreen({ type: 'aot_pcm_end', durationSeconds: msg.durationSeconds, clientId: owner?.clientId }, owner?.tabId);
      disconnectNativePort();
      activeAotOwner = null;
      return;
    }
    if (msg.type === 'error') {
      const code = msg.code ?? 'NATIVE_HOST_ERROR';
      void forwardToOffscreen({ type: 'aot_pcm_error', reason: `${code}: ${msg.message ?? 'native host error'}`, clientId: owner?.clientId }, owner?.tabId);
      disconnectNativePort();
      activeAotOwner = null;
      return;
    }
  });

  port.onDisconnect.addListener(() => {
    if (port !== nativePort) return;
    const lastError = chrome.runtime.lastError;
    const owner = activeAotOwner;
    nativePort = null;
    if (lastError) {
      void forwardToOffscreen({ type: 'aot_pcm_error', reason: `NO_NATIVE_HOST: ${lastError.message ?? 'disconnected'}`, clientId: owner?.clientId }, owner?.tabId);
    } else {
      void forwardToOffscreen({ type: 'aot_pcm_end', clientId: owner?.clientId }, owner?.tabId);
    }
    activeAotOwner = null;
  });

  try {
    port.postMessage({ type: 'start', videoId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    void forwardToOffscreen({ type: 'aot_pcm_error', reason: `NO_NATIVE_HOST: ${message}`, clientId });
    disconnectNativePort();
    activeAotOwner = null;
  }
}

function stopNativeStream(clientId?: string) {
  if (clientId && activeAotOwner?.clientId !== clientId) return;
  disconnectNativePort();
  activeAotOwner = null;
}

function probeNativeHost(tabId: number | undefined, clientId: string | undefined) {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sendToTab(tabId, { type: 'host_status', ok: false, reason: `NO_NATIVE_HOST: ${message}`, tabId, clientId });
    return;
  }

  let resolved = false;
  const resolve = (ok: boolean, reason?: string) => {
    if (resolved) return;
    resolved = true;
    try { port.disconnect(); } catch {}
    sendToTab(tabId, { type: 'host_status', ok, reason, tabId, clientId });
  };

  port.onMessage.addListener((msg: { type?: string }) => {
    if (msg?.type === 'pong') resolve(true);
  });

  port.onDisconnect.addListener(() => {
    const lastError = chrome.runtime.lastError;
    resolve(false, `NO_NATIVE_HOST: ${lastError?.message ?? 'disconnected'}`);
  });

  try {
    port.postMessage({ type: 'ping' });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    resolve(false, `NO_NATIVE_HOST: ${message}`);
  }

  setTimeout(() => resolve(false, 'NO_NATIVE_HOST: probe timeout'), PROBE_TIMEOUT_MS);
}

async function handleContentCommand(data: Record<string, unknown>, tabId: number | undefined) {
  const type = data.type;
  const clientId = typeof data.clientId === 'string' ? data.clientId : undefined;

  if (type === 'host_probe') {
    probeNativeHost(tabId, clientId);
    return;
  }

  if (type === 'load_aot') {
    const videoId = typeof data.videoId === 'string' ? data.videoId : '';
    if (!videoId || !clientId) {
      sendToTab(tabId, { type: 'aot_pcm_error', reason: 'NO_NATIVE_HOST: missing videoId or clientId', clientId, tabId });
      return;
    }
    await forwardToOffscreen(data, tabId);
    startNativeStream(videoId, tabId, clientId);
    return;
  }

  if (type === 'stop_aot') {
    stopNativeStream(clientId);
    await forwardToOffscreen(data, tabId);
    return;
  }

  await forwardToOffscreen(data, tabId);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg._fromOffscreen) {
    if (typeof msg.tabId === 'number') {
      chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {
        activeTabs.delete(msg.tabId);
      });
    } else if (GLOBAL_EVENT_TYPES.has(msg.type)) {
      for (const tabId of activeTabs) {
        chrome.tabs.sendMessage(tabId, msg).catch(() => {
          activeTabs.delete(tabId);
        });
      }
    }
    return;
  }

  if (msg.target === 'offscreen') {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number') activeTabs.add(tabId);

    handleContentCommand(msg.data, tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('[mutely:bg] Failed to handle content command:', error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
  if (activeAotOwner?.tabId === tabId) {
    stopNativeStream();
  }
});
