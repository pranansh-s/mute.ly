/**
 * Mute.ly Background Service Worker
 * 
 * Simple message relay using sendMessage (no ports).
 * Content → Background → Offscreen (via sendMessage)
 * Offscreen → Background → Content (via tabs.sendMessage)
 */

let activeTabId: number | null = null;
let creationPromise: Promise<void> | null = null;

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

  return creationPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages FROM offscreen worker (loading, ready, result, error)
  if (msg._fromOffscreen) {
    if (activeTabId !== null) {
      chrome.tabs.sendMessage(activeTabId, msg).catch(() => {});
    }
    return;
  }

  // Messages FROM content script (target: offscreen)
  if (msg.target === 'offscreen') {
    activeTabId = sender.tab?.id ?? activeTabId;

    ensureOffscreen().then(() => {
      // Forward the inner data to all extension pages (offscreen will catch it)
      chrome.runtime.sendMessage({ ...msg.data, _fromBackground: true }).catch(() => {});
    });

    sendResponse({ ok: true });
    return;
  }
});
