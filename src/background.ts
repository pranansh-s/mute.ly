/**
 * Mute.ly Background Service Worker
 * 
 * Simple message relay using sendMessage (no ports).
 * Content → Background → Offscreen (via sendMessage)
 * Offscreen → Background → Content (via tabs.sendMessage)
 */

let creationPromise: Promise<void> | null = null;
const activeTabs = new Set<number>();

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
  })().catch((err) => {
    // Reset so next attempt can retry
    creationPromise = null;
    throw err;
  });

  return creationPromise;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages FROM offscreen worker (loading, ready, result, error)
  if (msg._fromOffscreen) {
    if (msg.tabId) {
      chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
    } else {
      // Broadcast global events (like loading/ready) to all known active tabs
      for (const tabId of activeTabs) {
        chrome.tabs.sendMessage(tabId, msg).catch(() => {});
      }
    }
    return;
  }

  // Messages FROM content script (target: offscreen)
  if (msg.target === 'offscreen') {
    const tabId = sender.tab?.id;
    if (tabId) activeTabs.add(tabId);

    ensureOffscreen().then(() => {
      // Forward the inner data to offscreen, attaching the source tabId
      chrome.runtime.sendMessage({ ...msg.data, _fromBackground: true, tabId }).catch(() => {});
    });

    sendResponse({ ok: true });
    return;
  }
});
