chrome.runtime.onInstalled.addListener(() => {
  console.log('[Background] Extension installed');
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[Background] Extension started');
});

setInterval(() => {
  console.log('[Background] Keep-alive ping');
}, 20000);
