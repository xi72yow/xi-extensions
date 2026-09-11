// Background script for WebTweaks

// Initialize default settings on install
chrome.runtime.onInstalled.addListener(() => {
  // Set default video speed settings
  chrome.storage.sync.get(
    ["speedRules", "globalSpeed", "zoomPreset", "customZoomValue"],
    (result) => {
      if (!result.globalSpeed) {
        chrome.storage.sync.set({ globalSpeed: 1.5 });
      }
      if (!result.speedRules) {
        chrome.storage.sync.set({ speedRules: {} });
      }
      if (!result.zoomPreset) {
        chrome.storage.sync.set({ zoomPreset: "none" });
      }
      if (!result.customZoomValue) {
        chrome.storage.sync.set({ customZoomValue: 100 });
      }
    },
  );
});

// Handle tab updates to apply speed rules
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    // Send current settings to the tab
    chrome.storage.sync.get(["speedRules", "globalSpeed", "regexRules"], (result) => {
      chrome.tabs
        .sendMessage(tabId, {
          action: "updateRules",
          rules: result.speedRules || {},
          regexRules: result.regexRules || [],
          globalSpeed: result.globalSpeed || 1.5,
        })
        .catch(() => {
          // Ignore errors for tabs that don't have our content script
        });
    });
  }
});
