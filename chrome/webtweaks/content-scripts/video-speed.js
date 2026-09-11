(function () {
  "use strict";

  console.log(
    "[VideoSpeed] 🔥 VERSION 2.0 WITH BASE DOMAIN MATCHING LOADED 🔥",
  );

  let currentSpeed = null; // null = not yet loaded from storage
  let speedRules = {};
  let regexRules = [];
  let globalSpeed = 1.5;
  let currentZoom = 100;
  let currentZoomPosition = 50; // Default to center (50%)

  // Interactive zoom state (Ctrl+A + Wheel)
  let ctrlPressed = false;
  let aKeyPressed = false;
  let activeZoomVideo = null;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let lastMouseX = 0;
  let lastMouseY = 0;

  // Function to determine speed based on URL
  function getSpeedForUrl() {
    const hostname = window.location.hostname;
    const fullUrl = window.location.href;

    console.log("[VideoSpeed] Checking speed for:", hostname);
    console.log("[VideoSpeed] Available domain rules:", speedRules);
    console.log("[VideoSpeed] Available regex rules:", regexRules);
    console.log("[VideoSpeed] Global speed:", globalSpeed);

    // Use shared matching logic (from globally loaded script)
    const result = window.SpeedRulesMatcher.getSpeedForUrl(
      fullUrl,
      hostname,
      speedRules,
      regexRules,
      globalSpeed,
    );

    // Log the result
    if (result.matchType === "regex") {
      console.log(
        "[VideoSpeed] ✓ Matched regex rule:",
        result.pattern,
        "-> Speed:",
        result.speed,
      );
    } else if (result.matchType === "domain-exact") {
      console.log(
        "[VideoSpeed] ✓ Matched domain rule:",
        result.pattern,
        "-> Speed:",
        result.speed,
      );
    } else if (result.matchType === "domain-base") {
      console.log(
        "[VideoSpeed] ✓ Matched base domain rule:",
        result.pattern,
        "for",
        hostname,
        "(base:",
        result.baseDomain,
        ") -> Speed:",
        result.speed,
      );
    } else {
      console.log(
        "[VideoSpeed] ✗ No rule matched, using global speed:",
        result.speed,
      );
    }

    return result.speed;
  }

  // Load settings from storage (only speed settings, not zoom)
  chrome.storage.sync.get(
    ["speedRules", "globalSpeed", "regexRules"],
    (result) => {
      speedRules = result.speedRules || {};
      regexRules = result.regexRules || [];
      globalSpeed = result.globalSpeed || 1.5;

      // Zoom always starts at 100% (no zoom) - not saved between sessions
      currentZoom = 100;

      // Determine speed for current site
      currentSpeed = getSpeedForUrl();

      // Apply initial speed only (no zoom by default)
      setSpeed();

      // Force apply speed after a short delay to ensure it takes effect
      setTimeout(setSpeed, 100);
      setTimeout(setSpeed, 500);
    },
  );

  // Listen for messages from popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "getSpeed") {
      // Return the current speed to the popup
      sendResponse({ speed: currentSpeed });
      return true;
    } else if (request.action === "setSpeed") {
      currentSpeed = request.speed;
      setSpeed();
    } else if (request.action === "updateRules") {
      speedRules = request.rules;
      if (request.regexRules) regexRules = request.regexRules;
      globalSpeed = request.globalSpeed;
      currentSpeed = getSpeedForUrl();
      setSpeed();
    } else if (request.action === "updateRegexRules") {
      regexRules = request.regexRules;
      currentSpeed = getSpeedForUrl();
      setSpeed();
    } else if (request.action === "setZoom") {
      currentZoom = request.zoom;
      if (request.position !== undefined) {
        currentZoomPosition = request.position;
      }
      applyZoom();
    } else if (request.action === "setZoomPosition") {
      currentZoomPosition = request.position;
      applyZoom();
    } else if (request.action === "getZoom") {
      // Return current zoom level to popup
      sendResponse({ zoom: currentZoom, position: currentZoomPosition });
    } else if (request.action === "detectLetterbox") {
      // Manual letterbox detection triggered from popup
      const videos = document.querySelectorAll("video");
      if (videos.length === 0) {
        sendResponse({ error: "No video found on this page" });
        return;
      }

      let detectedZoom = null;
      for (const video of videos) {
        detectedZoom = detectLetterboxing(video);
        if (detectedZoom) {
          currentZoom = detectedZoom;
          applyZoom();
          sendResponse({ zoom: detectedZoom });
          return;
        }
      }

      sendResponse({ error: "No letterboxing detected in videos" });
    } else if (request.action === "openPiP") {
      // Open video in Picture-in-Picture mode (main document only)
      const videos = document.querySelectorAll("video");

      if (videos.length === 0) {
        sendResponse({ error: "No video found on this page" });
        return true;
      }

      // Find the largest or playing video
      let video = videos[0];
      for (const v of videos) {
        if (!v.paused || v.videoWidth > video.videoWidth) {
          video = v;
        }
      }

      console.log(
        "[PiP] Found video, size:",
        video.videoWidth,
        "x",
        video.videoHeight,
      );

      // Check if PiP is supported
      if (!document.pictureInPictureEnabled) {
        sendResponse({ error: "Picture-in-Picture is not supported" });
        return true;
      }

      // Check if already in PiP
      if (document.pictureInPictureElement) {
        sendResponse({ error: "Video is already in Picture-in-Picture" });
        return true;
      }

      // Remove disablePictureInPicture attribute if present (some sites block PiP)
      if (video.hasAttribute("disablePictureInPicture")) {
        video.removeAttribute("disablePictureInPicture");
      }

      // Request PiP
      video
        .requestPictureInPicture()
        .then(() => {
          console.log("[PiP] Success!");
          sendResponse({ success: true });
        })
        .catch((error) => {
          console.error("[PiP] Error:", error);
          sendResponse({ error: `PiP failed: ${error.message}` });
        });

      return true; // Keep message channel open for async response
    }
  });

  // Listen for storage changes (only for speed settings)
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === "sync") {
      if (changes.speedRules) {
        speedRules = changes.speedRules.newValue || {};
      }
      if (changes.globalSpeed) {
        globalSpeed = changes.globalSpeed.newValue || 1.5;
      }
      if (changes.regexRules) {
        regexRules = changes.regexRules.newValue || [];
      }
      // No longer listening for customZoomValue changes
      currentSpeed = getSpeedForUrl();
      setSpeed();
    }
  });

  function setSpeed() {
    // Don't apply speed until rules are loaded from storage
    if (currentSpeed === null) return;
    document.querySelectorAll("video, audio").forEach((el) => {
      el.playbackRate = currentSpeed;
      // Also set defaultPlaybackRate to make it more persistent
      el.defaultPlaybackRate = currentSpeed;
    });
  }

  // Detect letterboxing (black bars) in video
  function detectLetterboxing(video) {
    if (!video.videoWidth || !video.videoHeight) return null;

    try {
      // Create a canvas to sample the video
      const canvas = document.createElement("canvas");
      // Add willReadFrequently for better performance with multiple getImageData calls
      const ctx = canvas.getContext("2d", { willReadFrequently: true });

      // Use smaller dimensions for performance
      const sampleWidth = 320;
      const sampleHeight = Math.floor(
        (video.videoHeight / video.videoWidth) * sampleWidth,
      );

      canvas.width = sampleWidth;
      canvas.height = sampleHeight;

      // Draw current video frame
      ctx.drawImage(video, 0, 0, sampleWidth, sampleHeight);

      // Sample pixels from top and bottom edges
      const topData = ctx.getImageData(0, 0, sampleWidth, 5);
      const bottomData = ctx.getImageData(0, sampleHeight - 5, sampleWidth, 5);

      // Check if edges are mostly black
      function isBlack(imageData) {
        const pixels = imageData.data;
        let blackPixels = 0;
        const threshold = 30; // RGB values below this are considered black

        for (let i = 0; i < pixels.length; i += 4) {
          const r = pixels[i];
          const g = pixels[i + 1];
          const b = pixels[i + 2];
          if (r < threshold && g < threshold && b < threshold) {
            blackPixels++;
          }
        }

        return blackPixels / (pixels.length / 4) > 0.9; // 90% black pixels
      }

      const hasTopBar = isBlack(topData);
      const hasBottomBar = isBlack(bottomData);

      if (hasTopBar && hasBottomBar) {
        // Detect approximate aspect ratio based on black bars
        // Sample middle of video to find actual content area
        let contentTop = 0;
        let contentBottom = sampleHeight;

        // Find where content starts from top
        for (let y = 0; y < sampleHeight / 2; y += 2) {
          const rowData = ctx.getImageData(0, y, sampleWidth, 1);
          if (!isBlack(rowData)) {
            contentTop = y;
            break;
          }
        }

        // Find where content ends from bottom
        for (let y = sampleHeight - 1; y > sampleHeight / 2; y -= 2) {
          const rowData = ctx.getImageData(0, y, sampleWidth, 1);
          if (!isBlack(rowData)) {
            contentBottom = y;
            break;
          }
        }

        const contentHeight = contentBottom - contentTop;
        const detectedAspectRatio = sampleWidth / contentHeight;

        // Determine zoom level based on detected aspect ratio
        if (detectedAspectRatio > 2.2) {
          return 131; // 21:9 content
        } else if (detectedAspectRatio > 1.9) {
          return 120; // Slightly wider than 16:9
        }
      }

      return null; // No letterboxing detected
    } catch (e) {
      console.error("Error detecting letterboxing:", e);
      return null;
    }
  }

  function applyZoom() {
    document.querySelectorAll("video").forEach((video) => {
      // Skip if already has the correct zoom and position to avoid reapplying
      if (
        video.dataset.appliedZoom === String(currentZoom) &&
        video.dataset.appliedPosition === String(currentZoomPosition)
      ) {
        return;
      }

      // Reset all styles first
      video.style.removeProperty("transform");
      video.style.removeProperty("transform-origin");
      video.style.removeProperty("object-fit");

      if (currentZoom === 100) {
        // 16:9 - Original aspect ratio, no changes
        delete video.dataset.appliedZoom;
        delete video.dataset.appliedPosition;
        delete video.dataset.autoDetected;

        // Reset parent overflow
        const parent = video.parentElement;
        if (parent && parent.dataset.zoomModified === "true") {
          parent.style.removeProperty("overflow");
          delete parent.dataset.zoomModified;
        }
      } else {
        // Apply zoom - scale the video to crop it
        const scale = currentZoom / 100;
        video.style.transform = `scale(${scale})`;
        // Use currentZoomPosition for vertical positioning
        // 0% = top, 50% = center, 100% = bottom
        video.style.transformOrigin = `center ${currentZoomPosition}%`;
        video.dataset.appliedZoom = String(currentZoom);
        video.dataset.appliedPosition = String(currentZoomPosition);

        // Hide overflow on parent
        const parent = video.parentElement;
        if (parent) {
          parent.style.overflow = "hidden";
          parent.dataset.zoomModified = "true";
        }
      }
    });
  }

  // Auto-detect letterboxing when video starts playing
  function enableAutoDetection() {
    document.addEventListener(
      "loadedmetadata",
      (e) => {
        if (e.target.tagName === "VIDEO" && !e.target.dataset.autoChecked) {
          e.target.dataset.autoChecked = "true";

          // Wait a bit for video to load first frame
          setTimeout(() => {
            const detectedZoom = detectLetterboxing(e.target);
            if (detectedZoom && currentZoom === 100) {
              // Only auto-zoom if user hasn't manually set a zoom
              currentZoom = detectedZoom;
              e.target.dataset.autoDetected = "true";
              applyZoom();

              // Notify popup about auto-detection
              chrome.runtime
                .sendMessage({
                  action: "autoZoomDetected",
                  zoom: detectedZoom,
                })
                .catch(() => {});
            }
          }, 500);
        }
      },
      true,
    );
  }

  // Initial setup
  setSpeed();
  // Auto-detection disabled - now triggered manually via button
  // enableAutoDetection();

  // MutationObserver to handle dynamically added videos
  const observer = new MutationObserver(() => {
    // Apply speed to new videos
    setSpeed();

    // Only reapply zoom if zoom is active
    if (currentZoom !== 100) {
      // Apply zoom to new videos only
      document.querySelectorAll("video").forEach((video) => {
        if (!video.dataset.appliedZoom) {
          const scale = currentZoom / 100;
          video.style.transform = `scale(${scale})`;
          video.style.transformOrigin = `center ${currentZoomPosition}%`;
          video.dataset.appliedZoom = String(currentZoom);
          video.dataset.appliedPosition = String(currentZoomPosition);

          const parent = video.parentElement;
          if (parent && parent.dataset.zoomModified !== "true") {
            parent.style.overflow = "hidden";
            parent.dataset.zoomModified = "true";
          }
        }
      });
    }
  });

  // Start observing
  function startObserving() {
    if (document.body) {
      observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  // Try to start observing immediately
  startObserving();

  // Also try when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", startObserving);
  }

  // Fallback for edge cases
  if (!document.body) {
    const checkBody = setInterval(() => {
      if (document.body) {
        startObserving();
        clearInterval(checkBody);
      }
    }, 100);
  }

  // Handle play events
  document.addEventListener(
    "play",
    (e) => {
      if (e.target.tagName === "VIDEO" || e.target.tagName === "AUDIO") {
        if (currentSpeed !== null) {
          e.target.playbackRate = currentSpeed;
          e.target.defaultPlaybackRate = currentSpeed;
        }

        // Apply zoom to video if needed
        if (e.target.tagName === "VIDEO" && currentZoom !== 100) {
          const video = e.target;
          if (
            !video.dataset.appliedZoom ||
            video.dataset.appliedZoom !== String(currentZoom) ||
            video.dataset.appliedPosition !== String(currentZoomPosition)
          ) {
            const scale = currentZoom / 100;
            video.style.transform = `scale(${scale})`;
            video.style.transformOrigin = `center ${currentZoomPosition}%`;
            video.dataset.appliedZoom = String(currentZoom);
            video.dataset.appliedPosition = String(currentZoomPosition);

            const parent = video.parentElement;
            if (parent && parent.dataset.zoomModified !== "true") {
              parent.style.overflow = "hidden";
              parent.dataset.zoomModified = "true";
            }
          }
        }
      }
    },
    true,
  );

  // Also handle loadstart and canplay events to ensure speed is set early
  ["loadstart", "canplay", "loadeddata"].forEach((eventName) => {
    document.addEventListener(
      eventName,
      (e) => {
        if (
          currentSpeed !== null &&
          (e.target.tagName === "VIDEO" || e.target.tagName === "AUDIO")
        ) {
          e.target.playbackRate = currentSpeed;
          e.target.defaultPlaybackRate = currentSpeed;
        }
      },
      true,
    );
  });

  // Periodic check for speed only (not zoom to avoid flickering)
  setInterval(() => {
    document.querySelectorAll("video, audio").forEach((el) => {
      if (el.playbackRate !== currentSpeed) {
        el.playbackRate = currentSpeed;
      }
    });
  }, 1000);

  // ── Interactive Zoom (Ctrl+A + Wheel to zoom, drag to pan) ──

  function findVisibleVideo(target) {
    // Check if target is or contains a video
    let video = target.closest("video");
    if (video) return video;

    // Check if target is inside a video player wrapper
    const container = target.closest(
      "[class*='player'], [class*='video'], [id*='player'], [id*='video']",
    );
    if (container) {
      video = container.querySelector("video");
      if (video) return video;
    }

    // Fallback: find the largest visible video on the page
    let best = null;
    let bestArea = 0;
    document.querySelectorAll("video").forEach((v) => {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea && rect.width > 0 && rect.height > 0) {
        best = v;
        bestArea = area;
      }
    });
    return best;
  }

  function applyInteractiveZoom(video) {
    if (currentZoom > 100) {
      // Save original styles on first zoom
      if (!video.dataset.izOriginalStyle) {
        video.dataset.izOriginalStyle = video.getAttribute("style") || "";
      }

      // Make video fill viewport in a fixed overlay
      video.style.position = "fixed";
      video.style.top = "0";
      video.style.left = "0";
      video.style.width = "100vw";
      video.style.height = "100vh";
      video.style.zIndex = "2147483647";
      video.style.objectFit = "contain";
      video.style.background = "black";
      video.style.cursor = isDragging ? "grabbing" : "grab";

      // Apply zoom + pan
      const scale = currentZoom / 100;
      video.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
      video.style.transformOrigin = "center center";
    } else {
      // Reset to original
      resetInteractiveZoom(video);
    }
  }

  function resetInteractiveZoom(video) {
    if (video && video.dataset.izOriginalStyle !== undefined) {
      const orig = video.dataset.izOriginalStyle;
      if (orig) {
        video.setAttribute("style", orig);
      } else {
        video.removeAttribute("style");
      }
      delete video.dataset.izOriginalStyle;
    }
    panX = 0;
    panY = 0;
    activeZoomVideo = null;
  }

  // Track Ctrl and A key state
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Control") ctrlPressed = true;
      if (e.key === "a" || e.key === "A") {
        aKeyPressed = true;
        // Prevent select-all when Ctrl+A is used for zoom
        if (ctrlPressed) {
          e.preventDefault();
        }
      }
    },
    true,
  );

  document.addEventListener(
    "keyup",
    (e) => {
      if (e.key === "Control") ctrlPressed = false;
      if (e.key === "a" || e.key === "A") aKeyPressed = false;
    },
    true,
  );

  // Ctrl+A + Wheel = zoom
  document.addEventListener(
    "wheel",
    (e) => {
      if (!ctrlPressed || !aKeyPressed) return;

      // Always prevent browser scroll/zoom when Ctrl+A is held
      e.preventDefault();
      e.stopPropagation();

      const video = activeZoomVideo || findVisibleVideo(e.target);
      if (!video) return;

      activeZoomVideo = video;

      const zoomDelta = e.deltaY < 0 ? 10 : -10;
      const newZoom = Math.max(100, Math.min(500, currentZoom + zoomDelta));
      currentZoom = newZoom;

      if (currentZoom <= 100) {
        // Scrolled back to original - fully reset
        currentZoom = 100;
        resetInteractiveZoom(video);
        return;
      }

      applyInteractiveZoom(video);
    },
    { passive: false, capture: true },
  );

  // Block clicks when Ctrl+A is held and zoomed (prevents video pause)
  document.addEventListener(
    "click",
    (e) => {
      if (ctrlPressed && aKeyPressed && activeZoomVideo && currentZoom > 100) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    },
    true,
  );

  // Drag to pan when zoomed
  document.addEventListener(
    "mousedown",
    (e) => {
      if (!activeZoomVideo || currentZoom <= 100) return;
      isDragging = true;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;
      activeZoomVideo.style.cursor = "grabbing";
      e.preventDefault();
    },
    true,
  );

  document.addEventListener(
    "mousemove",
    (e) => {
      if (!isDragging || !activeZoomVideo) return;

      const scale = currentZoom / 100;
      panX += (e.clientX - lastMouseX) / scale;
      panY += (e.clientY - lastMouseY) / scale;
      lastMouseX = e.clientX;
      lastMouseY = e.clientY;

      activeZoomVideo.style.transform = `scale(${scale}) translate(${panX}px, ${panY}px)`;
    },
    true,
  );

  document.addEventListener(
    "mouseup",
    () => {
      if (isDragging && activeZoomVideo) {
        isDragging = false;
        activeZoomVideo.style.cursor = "grab";
      }
    },
    true,
  );
})();
