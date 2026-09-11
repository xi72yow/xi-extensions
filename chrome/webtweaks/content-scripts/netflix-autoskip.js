// Netflix Auto-Skip mit MutationObserver
// Reagiert nur bei tatsächlichen DOM-Änderungen — kein unnötiges Polling mehr

let autoSkipEnabled = true;
let observer = null;

const selectors = [
  "[data-uia='next-episode-seamless-button']",
  "[data-uia='next-episode-seamless-button-draining']",
  "[data-uia='player-skip-intro']",
  "[data-uia='player-skip-recap']",
  "[data-uia='player-skip-credits']",
  "[data-uia='player-skip-preplay']",
  ".watch-video--skip-content button",
  ".watch-video--skip-content-button",
  ".watch-video--skip-preplay-button"
];

function tryClickSkipButton() {
  if (!autoSkipEnabled) return false;

  for (const sel of selectors) {
    const btn = document.querySelector(sel);
    if (btn && btn.offsetParent !== null) {
      btn.click();
      return true;
    }
  }
  return false;
}

function startObserver() {
  if (observer) return;

  observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.addedNodes.length > 0) {
        tryClickSkipButton();
        return;
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Initialer Check falls Buttons bereits existieren
  tryClickSkipButton();
}

function stopObserver() {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
}

// Einstellungen laden
chrome.storage.sync.get(["netflixAutoSkip"], (result) => {
  autoSkipEnabled = result.netflixAutoSkip !== false; // Default: enabled

  if (autoSkipEnabled) {
    if (document.body) {
      startObserver();
    } else {
      document.addEventListener("DOMContentLoaded", startObserver);
    }
  }
});

// Auf Nachrichten vom Popup reagieren
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "setNetflixAutoSkip") {
    autoSkipEnabled = request.enabled;

    if (autoSkipEnabled) {
      startObserver();
    } else {
      stopObserver();
    }

    sendResponse({ success: true });
  }
  return true;
});

// Storage-Änderungen überwachen (für Sync zwischen Tabs)
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === "sync" && changes.netflixAutoSkip) {
    autoSkipEnabled = changes.netflixAutoSkip.newValue !== false;

    if (autoSkipEnabled) {
      startObserver();
    } else {
      stopObserver();
    }
  }
});
