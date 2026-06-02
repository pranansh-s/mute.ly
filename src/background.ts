/**
 * Mute.ly Background Service Worker
 * 
 * Simple message relay using sendMessage (no ports).
 * Content → Background → Offscreen (via sendMessage)
 * Offscreen → Background → Content (via tabs.sendMessage)
 */

let creationPromise: Promise<void> | null = null;
const activeTabs = new Set<number>();
const GLOBAL_EVENT_TYPES = new Set(['loading', 'ready', 'error']);

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
    await chrome.runtime.sendMessage(payload);
  }
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

    forwardToOffscreen(msg.data, tabId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error('[mutely:bg] Failed to forward message to offscreen:', error);
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      });

    return true;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  activeTabs.delete(tabId);
});
