// Open in new window button
document.getElementById("openInWindow").addEventListener("click", () => {
  chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: 450,
    height: 600,
  });
  window.close();
});

// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    // Remove active from all tabs and contents
    document
      .querySelectorAll(".tab")
      .forEach((t) => t.classList.remove("active"));
    document
      .querySelectorAll(".tab-content")
      .forEach((c) => c.classList.remove("active"));

    // Add active to clicked tab
    tab.classList.add("active");

    // Show corresponding content
    const tabName = tab.dataset.tab;
    if (tabName === "speed") {
      document.getElementById("speedTab").classList.add("active");
    } else if (tabName === "twitch") {
      document.getElementById("twitchTab").classList.add("active");
    }
  });
});

// Netflix Auto-Skip Logic
let netflixAutoSkip = true;

// Load Netflix settings
chrome.storage.sync.get(["netflixAutoSkip"], (result) => {
  netflixAutoSkip = result.netflixAutoSkip !== false; // Default: enabled
  const checkbox = document.getElementById("netflixAutoSkip");
  if (checkbox) {
    checkbox.checked = netflixAutoSkip;
  }
});

// Netflix toggle handler
const netflixToggle = document.getElementById("netflixAutoSkip");
if (netflixToggle) {
  netflixToggle.addEventListener("change", (e) => {
    netflixAutoSkip = e.target.checked;
    chrome.storage.sync.set({ netflixAutoSkip });

    // Send to Netflix tab if open
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].url && tabs[0].url.includes("netflix.com")) {
        chrome.tabs
          .sendMessage(tabs[0].id, {
            action: "setNetflixAutoSkip",
            enabled: netflixAutoSkip,
          })
          .catch(() => {});
      }
    });
  });
}

// Video Speed Controller Logic
let speedRules = {};
let regexRules = [];
let globalSpeed = 1.5;
let currentZoomPreset = "none";
let customZoomValue = 100;
let zoomPositionValue = 50; // Default to center (50%)

// Load settings
chrome.storage.sync.get(
  ["speedRules", "globalSpeed", "regexRules"],
  (result) => {
    speedRules = result.speedRules || {};
    regexRules = result.regexRules || [];
    globalSpeed = result.globalSpeed || 1.5;

    document.getElementById("globalSpeedSlider").value = globalSpeed;
    document.getElementById("globalSpeedValue").textContent = globalSpeed + "x";

    updateRulesList();

    // Set initial active rule display
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]) {
        try {
          const url = new URL(tabs[0].url);
          const activeRule = getActiveRule(tabs[0].url, url.hostname);
          updateActiveRuleDisplay(activeRule.pattern);
        } catch (e) {
          updateActiveRuleDisplay("default");
        }
      }
    });
  },
);

// Helper function to update active rule display
function updateActiveRuleDisplay(pattern) {
  const ruleElement = document.getElementById("activeRule");
  if (ruleElement) {
    ruleElement.textContent = pattern;
    ruleElement.title = pattern; // Full pattern in tooltip
  }
}

// Helper function to find active rule for URL
function getActiveRule(url, hostname) {
  // Use shared matching logic (from globally loaded script)
  const result = window.SpeedRulesMatcher.getSpeedForUrl(
    url,
    hostname,
    speedRules,
    regexRules,
    globalSpeed,
  );

  // Convert to old format for compatibility
  return {
    type:
      result.matchType === "domain-exact" || result.matchType === "domain-base"
        ? "domain"
        : result.matchType,
    pattern: result.pattern,
    speed: result.speed,
  };
}

// Store current tab info globally for other functions
let currentTabHostname = null;

// Get current tab URL
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    try {
      const url = new URL(tabs[0].url);
      const hostname = url.hostname;
      currentTabHostname = hostname;

      // Find and display active rule
      const activeRule = getActiveRule(tabs[0].url, hostname);
      updateActiveRuleDisplay(activeRule.pattern);

      // Get actual speed from content script (more reliable than calculating)
      if (canInjectContentScript(tabs[0].url)) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          { action: "getSpeed" },
          (response) => {
            if (chrome.runtime.lastError || !response) {
              // Fallback to calculated speed if content script not ready
              document.getElementById("currentSpeedSlider").value =
                activeRule.speed;
              document.getElementById("currentSpeedValue").textContent =
                activeRule.speed + "x";
            } else {
              // Use actual speed from content script
              document.getElementById("currentSpeedSlider").value =
                response.speed;
              document.getElementById("currentSpeedValue").textContent =
                response.speed + "x";
            }
          },
        );
      } else {
        // Not a content script page, use calculated speed
        document.getElementById("currentSpeedSlider").value = activeRule.speed;
        document.getElementById("currentSpeedValue").textContent =
          activeRule.speed + "x";
      }

      // Check current zoom status
      if (canInjectContentScript(tabs[0].url)) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          {
            action: "getZoom",
          },
          (response) => {
            if (chrome.runtime.lastError) {
              // Silently ignore if content script not ready
              return;
            }
            if (response && response.zoom) {
              updateActiveZoomButton(response.zoom);
            }
          },
        );
      }
    } catch (e) {
      // Handle special URLs (chrome://, edge://, about:, etc.)
      currentTabHostname = null;
      document.getElementById("activeRule").textContent = "default";
    }
  }
});

// Listen for auto-detection messages
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "autoZoomDetected") {
    // Show the auto-detect indicator
    const indicator = document.getElementById("autoDetectIndicator");
    if (indicator) {
      indicator.style.display = "block";
      updateActiveZoomButton(request.zoom);

      // Update the custom zoom slider to match
      document.getElementById("customZoom").value = request.zoom;
      document.getElementById("customZoomValue").textContent =
        request.zoom + "%";

      // Hide the indicator after 5 seconds
      setTimeout(() => {
        indicator.style.display = "none";
      }, 5000);
    }
  }
});

// Helper function to check if URL supports content scripts
function canInjectContentScript(url) {
  if (!url) return false;
  // Content scripts cannot run on chrome://, chrome-extension://, edge://, about:, etc.
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("file://")
  );
}

// Speed slider handlers
document.getElementById("currentSpeedSlider").addEventListener("input", (e) => {
  const value = parseFloat(e.target.value);
  document.getElementById("currentSpeedValue").textContent = value + "x";

  // Apply immediately to current tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && canInjectContentScript(tabs[0].url)) {
      chrome.tabs
        .sendMessage(tabs[0].id, {
          action: "setSpeed",
          speed: value,
        })
        .catch(() => {
          // Silently ignore if content script is not available
        });
    }
  });
});

// Throttle timer for global speed slider (saves every 200ms max)
let globalSpeedSaveTimer = null;
let canSaveGlobalSpeed = true;

document.getElementById("globalSpeedSlider").addEventListener("input", (e) => {
  globalSpeed = parseFloat(e.target.value);
  document.getElementById("globalSpeedValue").textContent = globalSpeed + "x";

  // Throttle: Save at most every 200ms
  if (canSaveGlobalSpeed) {
    chrome.storage.sync.set({ globalSpeed });
    canSaveGlobalSpeed = false;

    setTimeout(() => {
      canSaveGlobalSpeed = true;
      // Save the latest value after throttle period
      chrome.storage.sync.set({ globalSpeed });
    }, 200);
  }
});

// Save current speed for this site
document.getElementById("saveCurrentSpeed").addEventListener("click", () => {
  const hostname = currentTabHostname;
  const speed = parseFloat(document.getElementById("currentSpeedSlider").value);

  if (hostname) {
    speedRules[hostname] = speed;
    chrome.storage.sync.set({ speedRules }, () => {
      updateRulesList();
      // Update active rule display to show the new rule
      updateActiveRuleDisplay(hostname);
      // Notify content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && canInjectContentScript(tabs[0].url)) {
          chrome.tabs
            .sendMessage(tabs[0].id, {
              action: "updateRules",
              rules: speedRules,
              globalSpeed: globalSpeed,
            })
            .catch(() => {
              // Silently ignore if content script is not available
            });
        }
      });
    });
  }
});

// New unified rule input with automatic regex detection
const addRuleBtn = document.getElementById("addRuleBtn");
const patternInput = document.getElementById("newPattern");
const speedInput = document.getElementById("newSpeed");

// Helper function to detect if a pattern is likely regex
function isRegexPattern(pattern) {
  // Check for common regex characters
  const regexIndicators = [
    "^",
    "$",
    ".*",
    ".+",
    "\\",
    "[",
    "]",
    "(",
    ")",
    "|",
    "?",
    "*",
    "+",
    "{",
    "}",
  ];
  return regexIndicators.some((indicator) => pattern.includes(indicator));
}

// Add new rule (unified for domain and regex with auto-detection)
if (addRuleBtn) {
  addRuleBtn.addEventListener("click", () => {
    const pattern = patternInput.value.trim();
    const speed = parseFloat(speedInput.value || "1.5");

    if (pattern && !isNaN(speed) && speed >= 0.25 && speed <= 3) {
      // Auto-detect if pattern is regex
      const isRegex = isRegexPattern(pattern);

      if (isRegex) {
        // Test if pattern is valid regex
        try {
          new RegExp(pattern);
          regexRules.push({ pattern, speed });
          chrome.storage.sync.set({ regexRules }, () => {
            updateRulesList();
            patternInput.value = "";
            speedInput.value = "";

            // Check if new rule affects current page (respecting priority)
            chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
              if (tabs[0]) {
                try {
                  const url = new URL(tabs[0].url);
                  const activeRule = getActiveRule(tabs[0].url, url.hostname);
                  // Always update display with the actual active rule (which respects priority)
                  updateActiveRuleDisplay(activeRule.pattern);
                  // Update speed with the active rule's speed
                  document.getElementById("currentSpeedSlider").value =
                    activeRule.speed;
                  document.getElementById("currentSpeedValue").textContent =
                    activeRule.speed + "x";
                } catch (e) {}
              }

              // Notify content script
              if (tabs[0] && canInjectContentScript(tabs[0].url)) {
                chrome.tabs
                  .sendMessage(tabs[0].id, {
                    action: "updateRegexRules",
                    regexRules: regexRules,
                  })
                  .catch(() => {});
              }
            });
          });
        } catch (e) {
          alert("Invalid regular expression pattern: " + e.message);
        }
      } else {
        // Normal domain rule
        speedRules[pattern] = speed;
        chrome.storage.sync.set({ speedRules }, () => {
          updateRulesList();
          patternInput.value = "";
          speedInput.value = "";

          // Check if new rule affects current page (respecting priority)
          chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
              try {
                const url = new URL(tabs[0].url);
                const activeRule = getActiveRule(tabs[0].url, url.hostname);
                // Always update display with the actual active rule (which respects priority)
                updateActiveRuleDisplay(activeRule.pattern);
                // Update speed with the active rule's speed (not necessarily the new rule)
                document.getElementById("currentSpeedSlider").value =
                  activeRule.speed;
                document.getElementById("currentSpeedValue").textContent =
                  activeRule.speed + "x";
              } catch (e) {}
            }

            // Notify content script
            if (tabs[0] && canInjectContentScript(tabs[0].url)) {
              chrome.tabs
                .sendMessage(tabs[0].id, {
                  action: "updateRules",
                  rules: speedRules,
                  globalSpeed: globalSpeed,
                })
                .catch(() => {});
            }
          });
        });
      }
    }
  });
}

// Function to update active zoom button
function updateActiveZoomButton(zoomLevel) {
  // Remove active class from all buttons
  document.querySelectorAll(".zoom-btn").forEach((btn) => {
    btn.classList.remove("active");
  });

  // Add active class to the appropriate button
  if (zoomLevel === 120) {
    document.getElementById("quickZoom21Soft").classList.add("active");
  } else if (zoomLevel === 131) {
    document.getElementById("quickZoom21").classList.add("active");
  } else if (zoomLevel === 140) {
    document.getElementById("quickZoom32Soft").classList.add("active");
  } else if (zoomLevel === 200) {
    document.getElementById("quickZoom32").classList.add("active");
  } else {
    // For 100 or any other value, default to Original
    document.getElementById("quickZoomReset").classList.add("active");
  }
}

// Quick Zoom Buttons
// 21:9 Soft - Less aggressive crop
document.getElementById("quickZoom21Soft").addEventListener("click", () => {
  const zoomLevel = 120;
  applyZoomLevel(zoomLevel);
  updateActiveZoomButton(zoomLevel);
  // Update custom slider to reflect the zoom
  document.getElementById("customZoom").value = zoomLevel;
  document.getElementById("customZoomValue").textContent = zoomLevel + "%";
  customZoomValue = zoomLevel;
  // Don't save zoom to storage - keep it session-only
});

// 21:9 - Exact ultrawide crop
document.getElementById("quickZoom21").addEventListener("click", () => {
  const zoomLevel = 131;
  applyZoomLevel(zoomLevel);
  updateActiveZoomButton(zoomLevel);
  // Update custom slider to reflect the zoom
  document.getElementById("customZoom").value = zoomLevel;
  document.getElementById("customZoomValue").textContent = zoomLevel + "%";
  customZoomValue = zoomLevel;
  // Don't save zoom to storage - keep it session-only
});

// 32:9 Soft - Moderate crop
document.getElementById("quickZoom32Soft").addEventListener("click", () => {
  const zoomLevel = 140;
  applyZoomLevel(zoomLevel);
  updateActiveZoomButton(zoomLevel);
  // Update custom slider to reflect the zoom
  document.getElementById("customZoom").value = zoomLevel;
  document.getElementById("customZoomValue").textContent = zoomLevel + "%";
  customZoomValue = zoomLevel;
  // Don't save zoom to storage - keep it session-only
});

// 32:9 - Full super ultrawide crop
document.getElementById("quickZoom32").addEventListener("click", () => {
  const zoomLevel = 200;
  applyZoomLevel(zoomLevel);
  updateActiveZoomButton(zoomLevel);
  // Update custom slider to reflect the zoom
  document.getElementById("customZoom").value = zoomLevel;
  document.getElementById("customZoomValue").textContent = zoomLevel + "%";
  customZoomValue = zoomLevel;
  // Don't save zoom to storage - keep it session-only
});

document.getElementById("quickZoomReset").addEventListener("click", () => {
  const zoomLevel = 100;
  applyZoomLevel(zoomLevel);
  updateActiveZoomButton(zoomLevel);
  // Reset custom slider
  document.getElementById("customZoom").value = 100;
  document.getElementById("customZoomValue").textContent = "100%";
  customZoomValue = 100;
  // Don't save zoom to storage - keep it session-only
});

// Custom Zoom Controls
document.getElementById("customZoom").addEventListener("input", (e) => {
  customZoomValue = parseInt(e.target.value);
  document.getElementById("customZoomValue").textContent =
    customZoomValue + "%";
  // Don't save zoom to storage - keep it session-only
});

// Zoom Position Controls
document.getElementById("zoomPosition").addEventListener("input", (e) => {
  zoomPositionValue = parseInt(e.target.value);
  document.getElementById("zoomPositionValue").textContent =
    zoomPositionValue + "%";
  // Apply position immediately
  applyZoomPosition(zoomPositionValue);
});

document.getElementById("applyCustomZoom").addEventListener("click", () => {
  applyZoomLevel(customZoomValue);
});

// Helper function to apply zoom
function applyZoomLevel(zoomLevel) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && canInjectContentScript(tabs[0].url)) {
      chrome.tabs
        .sendMessage(tabs[0].id, {
          action: "setZoom",
          zoom: zoomLevel,
          position: zoomPositionValue,
        })
        .catch(() => {
          // Silently ignore - content script not available on this page
        });
    }
  });
}

// Helper function to apply zoom position
function applyZoomPosition(position) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && canInjectContentScript(tabs[0].url)) {
      chrome.tabs
        .sendMessage(tabs[0].id, {
          action: "setZoomPosition",
          position: position,
        })
        .catch(() => {
          // Silently ignore - content script not available on this page
        });
    }
  });
}

// Query current zoom from the active tab's content script
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0] && canInjectContentScript(tabs[0].url)) {
    chrome.tabs
      .sendMessage(tabs[0].id, { action: "getZoom" })
      .then((response) => {
        if (response && response.zoom) {
          customZoomValue = response.zoom;
        } else {
          customZoomValue = 100;
        }
        document.getElementById("customZoom").value = customZoomValue;
        document.getElementById("customZoomValue").textContent =
          customZoomValue + "%";
        updateActiveZoomButton(customZoomValue);
      })
      .catch(() => {
        // Fallback if content script is not ready or page was just loaded
        customZoomValue = 100;
        document.getElementById("customZoom").value = customZoomValue;
        document.getElementById("customZoomValue").textContent =
          customZoomValue + "%";
        updateActiveZoomButton(customZoomValue);
      });
  } else {
    // Default to 100 for non-content script pages
    customZoomValue = 100;
    document.getElementById("customZoom").value = customZoomValue;
    document.getElementById("customZoomValue").textContent =
      customZoomValue + "%";
    updateActiveZoomButton(customZoomValue);
  }
});

// Update rules list display
function updateRulesList(searchTerm = "") {
  const container = document.getElementById("speedRules");

  // Combine normal and regex rules
  const allRules = [];

  // Add normal domain rules
  for (const [url, speed] of Object.entries(speedRules)) {
    allRules.push({ pattern: url, speed, type: "domain" });
  }

  // Add regex rules
  for (const rule of regexRules) {
    allRules.push({ pattern: rule.pattern, speed: rule.speed, type: "regex" });
  }

  if (allRules.length === 0) {
    container.innerHTML = '<div class="empty-state">No saved rules</div>';
    return;
  }

  container.innerHTML = "";
  let hasVisibleRules = false;

  // Sort rules: regex rules first (higher priority), then alphabetically
  allRules.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "regex" ? -1 : 1; // Regex rules first
    }
    return a.pattern.localeCompare(b.pattern);
  });

  for (const rule of allRules) {
    // Filter by search term
    if (
      searchTerm &&
      !rule.pattern.toLowerCase().includes(searchTerm.toLowerCase())
    ) {
      continue;
    }
    hasVisibleRules = true;

    const ruleDiv = document.createElement("div");
    ruleDiv.className = "rule-item";
    const typeLabel =
      rule.type === "regex" ? '<span class="rule-type-badge">regex</span>' : "";

    ruleDiv.innerHTML = `
      <span class="rule-url">${rule.pattern}${typeLabel}</span>
      <span class="rule-speed">${rule.speed}×</span>
      <button class="remove-btn" data-pattern="${rule.pattern}" data-type="${rule.type}" title="Remove rule">×</button>
    `;
    container.appendChild(ruleDiv);
  }

  if (!hasVisibleRules) {
    container.innerHTML =
      '<div class="empty-state">No matching rules found</div>';
  }

  // Add remove handlers
  container.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const pattern = e.target.dataset.pattern;
      const type = e.target.dataset.type;

      if (type === "domain") {
        delete speedRules[pattern];
        chrome.storage.sync.set({ speedRules }, () =>
          updateRulesList(searchTerm),
        );
      } else {
        const index = regexRules.findIndex((r) => r.pattern === pattern);
        if (index !== -1) {
          regexRules.splice(index, 1);
          chrome.storage.sync.set({ regexRules }, () => {
            updateRulesList(searchTerm);
          });
        }
      }

      // Update active rule display and notify content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]) {
          // Update UI to show new active rule after deletion
          try {
            const url = new URL(tabs[0].url);
            const activeRule = getActiveRule(tabs[0].url, url.hostname);
            updateActiveRuleDisplay(activeRule.pattern);
            // Update speed display with new active rule
            document.getElementById("currentSpeedSlider").value =
              activeRule.speed;
            document.getElementById("currentSpeedValue").textContent =
              activeRule.speed + "x";
          } catch (e) {
            updateActiveRuleDisplay("default");
          }

          // Notify content script
          if (canInjectContentScript(tabs[0].url)) {
            chrome.tabs
              .sendMessage(tabs[0].id, {
                action: "updateRules",
                rules: speedRules,
                globalSpeed: globalSpeed,
              })
              .catch(() => {});

            if (type === "regex") {
              chrome.tabs
                .sendMessage(tabs[0].id, {
                  action: "updateRegexRules",
                  regexRules: regexRules,
                })
                .catch(() => {});
            }
          }
        }
      });
    });
  });
}

// Add search functionality
const searchInput = document.getElementById("searchRules");
if (searchInput) {
  searchInput.addEventListener("input", (e) => {
    updateRulesList(e.target.value);
  });
}

// Removed - now integrated into updateRulesList
function updateRegexRulesList() {
  const container = document.getElementById("regexRules");

  if (!container) return; // Safety check

  if (regexRules.length === 0) {
    container.innerHTML =
      '<div class="empty-state" style="font-size: 11px; color: #666;">No regex patterns configured</div>';
    return;
  }

  container.innerHTML = "";

  regexRules.forEach((rule, index) => {
    const ruleDiv = document.createElement("div");
    ruleDiv.className = "regex-rule-item";
    ruleDiv.innerHTML = `
      <span class="regex-pattern">${rule.pattern}</span>
      <span class="rule-speed">${rule.speed}×</span>
      <button class="remove-btn" data-index="${index}" title="Remove pattern">×</button>
    `;
    container.appendChild(ruleDiv);
  });

  // Add remove handlers
  container.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const index = parseInt(e.target.dataset.index);
      regexRules.splice(index, 1);
      chrome.storage.sync.set({ regexRules }, updateRegexRulesList);

      // Notify content script about regex rules update
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0] && canInjectContentScript(tabs[0].url)) {
          chrome.tabs
            .sendMessage(tabs[0].id, {
              action: "updateRegexRules",
              regexRules: regexRules,
            })
            .catch(() => {});
        }
      });
    });
  });
}

// Removed - now handled by unified addRuleBtn above

// Auto-detect letterbox button
const detectLetterboxBtn = document.getElementById("detectLetterbox");
if (detectLetterboxBtn) {
  detectLetterboxBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && canInjectContentScript(tabs[0].url)) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          {
            action: "detectLetterbox",
          },
          (response) => {
            if (response && response.zoom) {
              // Update zoom controls with detected value
              updateActiveZoomButton(response.zoom);
              document.getElementById("customZoom").value = response.zoom;
              document.getElementById("customZoomValue").textContent =
                response.zoom + "%";
              customZoomValue = response.zoom;

              // Show indicator
              const indicator = document.getElementById("autoDetectIndicator");
              if (indicator) {
                indicator.style.display = "block";
                indicator.textContent = `🎯 Letterbox detected - Applied ${response.zoom}%`;
                setTimeout(() => {
                  indicator.style.display = "none";
                }, 3000);
              }
            } else if (response && response.error) {
              alert(response.error);
            }
          },
        );
      }
    });
  });
}

// Picture-in-Picture button
const openPiPBtn = document.getElementById("openPiP");
if (openPiPBtn) {
  openPiPBtn.addEventListener("click", () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && canInjectContentScript(tabs[0].url)) {
        chrome.tabs.sendMessage(
          tabs[0].id,
          { action: "openPiP" },
          (response) => {
            if (chrome.runtime.lastError) {
              alert(
                "Could not connect to the page. Please reload the page and try again.",
              );
              return;
            }

            console.log("[PiP] Response received:", response);

            // Only show error if it's NOT "No video found" (because iframe might have video)
            if (
              response &&
              response.error &&
              !response.error.includes("No video found")
            ) {
              alert(response.error);
            } else if (response && response.success) {
              console.log("[PiP] Successfully opened Picture-in-Picture");
              // Optionally close popup after opening PiP
              // window.close();
            }
            // If "No video found" - don't show alert, because iframe might handle it
          },
        );
      } else {
        alert("Picture-in-Picture is not available on this page");
      }
    });
  });
}

// Twitch Live Tracker Logic (existing code)
let accessToken = null;
let refreshToken = null;
let clientId = null;
let userId = null;

// Check if already logged in
chrome.storage.local.get(
  ["twitchAccessToken", "twitchRefreshToken", "twitchClientId", "twitchUserId"],
  (result) => {
    if (result.twitchAccessToken && result.twitchClientId) {
      accessToken = result.twitchAccessToken;
      refreshToken = result.twitchRefreshToken;
      clientId = result.twitchClientId;
      userId = result.twitchUserId;
      showUserSection();
    }
  },
);

// Login button handler
document.getElementById("loginButton").addEventListener("click", async () => {
  const accessTokenInput = document
    .getElementById("accessTokenInput")
    .value.trim();
  const refreshTokenInput = document
    .getElementById("refreshTokenInput")
    .value.trim();
  const clientIdInput = document.getElementById("clientIdInput").value.trim();

  if (!accessTokenInput || !clientIdInput) {
    alert("Bitte Access Token und Client ID eingeben!");
    return;
  }

  // Validate token
  try {
    const response = await fetch("https://id.twitch.tv/oauth2/validate", {
      headers: {
        Authorization: `Bearer ${accessTokenInput}`,
      },
    });

    if (!response.ok) {
      throw new Error("Token ungültig");
    }

    const data = await response.json();
    userId = data.user_id;

    // Save tokens
    chrome.storage.local.set({
      twitchAccessToken: accessTokenInput,
      twitchRefreshToken: refreshTokenInput,
      twitchClientId: clientIdInput,
      twitchUserId: userId,
    });

    accessToken = accessTokenInput;
    refreshToken = refreshTokenInput;
    clientId = clientIdInput;

    showUserSection();
  } catch (error) {
    alert("Fehler: " + error.message);
  }
});

// Logout handler
document.getElementById("logoutButton").addEventListener("click", () => {
  chrome.storage.local.remove([
    "twitchAccessToken",
    "twitchRefreshToken",
    "twitchClientId",
    "twitchUserId",
  ]);
  accessToken = null;
  refreshToken = null;
  clientId = null;
  userId = null;
  document.getElementById("loginSection").style.display = "block";
  document.getElementById("userSection").style.display = "none";
  document.getElementById("accessTokenInput").value = "";
  document.getElementById("refreshTokenInput").value = "";
});

// Refresh button handler
document.getElementById("refreshButton").addEventListener("click", () => {
  loadFollowedChannels();
});

// Open live streams buttons - only add if elements exist
const openLiveStreamsBtn = document.getElementById("openLiveStreams");
if (openLiveStreamsBtn) {
  openLiveStreamsBtn.addEventListener("click", () => {
    const liveChannels = Array.from(
      document.querySelectorAll(".channel-item.live"),
    ).map((el) => el.dataset.channel);

    if (liveChannels.length === 0) {
      alert("Keine Live-Streams gefunden!");
      return;
    }

    // Create new window with all streams as tabs
    chrome.windows.create({
      url: liveChannels.map((channel) => `https://twitch.tv/${channel}`),
      focused: true,
      state: "maximized",
    });
  });
}

const openLiveStreamsSeparateBtn = document.getElementById(
  "openLiveStreamsSeparate",
);
if (openLiveStreamsSeparateBtn) {
  openLiveStreamsSeparateBtn.addEventListener("click", () => {
    const liveChannels = Array.from(
      document.querySelectorAll(".channel-item.live"),
    ).map((el) => el.dataset.channel);

    if (liveChannels.length === 0) {
      alert("Keine Live-Streams gefunden!");
      return;
    }

    // Calculate optimal grid layout
    const numStreams = liveChannels.length;
    let cols, rows;

    if (numStreams === 1) {
      cols = 1;
      rows = 1;
    } else if (numStreams === 2) {
      cols = 2;
      rows = 1;
    } else if (numStreams === 3) {
      cols = 3;
      rows = 1;
    } else if (numStreams === 4) {
      cols = 2;
      rows = 2;
    } else if (numStreams <= 6) {
      cols = 3;
      rows = 2;
    } else if (numStreams <= 9) {
      cols = 3;
      rows = 3;
    } else if (numStreams <= 12) {
      cols = 4;
      rows = 3;
    } else if (numStreams <= 16) {
      cols = 4;
      rows = 4;
    } else {
      cols = Math.ceil(Math.sqrt(numStreams));
      rows = Math.ceil(numStreams / cols);
    }

    // Get screen dimensions
    const screenWidth = window.screen.availWidth;
    const screenHeight = window.screen.availHeight;

    const windowWidth = Math.floor(screenWidth / cols);
    const windowHeight = Math.floor(screenHeight / rows);

    // Create windows sequentially with forced positioning
    function createWindowAtPosition(channel, index) {
      const col = index % cols;
      const row = Math.floor(index / cols);

      const leftPos = col * windowWidth;
      const topPos = row * windowHeight;

      console.log(
        `Window ${index}: pos(${leftPos},${topPos}) size(${windowWidth}x${windowHeight})`,
      );

      chrome.windows.create(
        {
          url: `https://twitch.tv/${channel}`,
          type: "normal",
          state: "normal",
          focused: false,
          width: windowWidth,
          height: windowHeight,
          left: leftPos,
          top: topPos,
        },
        (window) => {
          // Immediately force the position again
          setTimeout(() => {
            chrome.windows.update(window.id, {
              left: leftPos,
              top: topPos,
              width: windowWidth,
              height: windowHeight,
              state: "normal",
            });
          }, 50);
        },
      );
    }

    // Create all windows with increasing delay
    liveChannels.forEach((channel, index) => {
      setTimeout(() => {
        createWindowAtPosition(channel, index);
      }, index * 250); // 250ms between windows
    });
  });
}

async function showUserSection() {
  document.getElementById("loginSection").style.display = "none";
  document.getElementById("userSection").style.display = "block";

  // Get user info
  try {
    const response = await fetch(
      `https://api.twitch.tv/helix/users?id=${userId}`,
      {
        headers: {
          "Client-ID": clientId,
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (response.ok) {
      const data = await response.json();
      document.getElementById("userName").textContent =
        `👤 ${data.data[0].display_name}`;
    }
  } catch (error) {
    console.error("Error fetching user info:", error);
  }

  loadFollowedChannels();
}

async function loadFollowedChannels() {
  const channelsList = document.getElementById("channelsList");
  channelsList.innerHTML = '<div class="loading">Lade gefolgte Kanäle...</div>';

  try {
    // Get followed channels
    const followResponse = await fetch(
      `https://api.twitch.tv/helix/channels/followed?user_id=${userId}&first=100`,
      {
        headers: {
          "Client-ID": clientId,
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    if (!followResponse.ok) {
      throw new Error("Fehler beim Laden der Kanäle");
    }

    const followData = await followResponse.json();
    const channels = followData.data;

    // Get live streams
    const channelIds = channels.map((c) => c.broadcaster_id);
    const liveResponse = await fetch(
      `https://api.twitch.tv/helix/streams?${channelIds
        .map((id) => `user_id=${id}`)
        .join("&")}`,
      {
        headers: {
          "Client-ID": clientId,
          Authorization: `Bearer ${accessToken}`,
        },
      },
    );

    const liveData = await liveResponse.json();
    const liveStreams = liveData.data;

    // Create channel list
    channelsList.innerHTML = "";
    let liveCount = 0;

    channels.forEach((channel) => {
      const isLive = liveStreams.find(
        (s) => s.user_id === channel.broadcaster_id,
      );
      if (isLive) liveCount++;

      const channelDiv = document.createElement("div");
      channelDiv.className = `channel-item ${isLive ? "live" : ""}`;
      channelDiv.dataset.channel = channel.broadcaster_login;

      let content = `
                <div class="status-indicator ${isLive ? "online" : "offline"}"></div>
                <span class="channel-name">${channel.broadcaster_name}</span>
            `;

      if (isLive) {
        content += `
                    <span class="viewer-count">${isLive.viewer_count.toLocaleString()}</span>
                    <span class="game-name">${isLive.game_name}</span>
                `;
      }

      channelDiv.innerHTML = content;

      // Add click handler to open individual channel in new window
      channelDiv.style.cursor = "pointer";
      channelDiv.addEventListener("click", () => {
        chrome.windows.create({
          url: `https://twitch.tv/${channel.broadcaster_login}`,
          type: "normal",
          state: "maximized",
          focused: true,
        });
      });

      channelsList.appendChild(channelDiv);
    });

    document.getElementById("liveCount").textContent =
      `${liveCount} Live / ${channels.length} Kanäle`;

    // Sort: live channels first
    const sortedChannels = Array.from(channelsList.children).sort((a, b) => {
      const aLive = a.classList.contains("live");
      const bLive = b.classList.contains("live");
      if (aLive && !bLive) return -1;
      if (!aLive && bLive) return 1;
      return 0;
    });

    channelsList.innerHTML = "";
    sortedChannels.forEach((channel) => channelsList.appendChild(channel));
  } catch (error) {
    channelsList.innerHTML = `<div class="empty-state">Fehler: ${error.message}</div>`;
  }
}
