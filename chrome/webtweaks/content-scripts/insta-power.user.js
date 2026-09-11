// ==UserScript==
// @name        Instagram Power Mode
// @namespace   xi72yow
// @match       https://www.instagram.com/*
// @grant       none
// @version     5.0
// @author      xi72yow
// @description Keyboard shortcuts: Arrow Keys navigate, M mute, L like, C comments, F full height mode
// @downloadURL https://raw.githubusercontent.com/xi72yow/WebTweaks/master/scripts/insta-power.user.js
// @updateURL   https://raw.githubusercontent.com/xi72yow/WebTweaks/master/scripts/insta-power.user.js
// ==/UserScript==

console.log("Instagram Power Mode v5.0 loading...");

// Add CSS for full height mode
const style = document.createElement("style");
style.textContent = `
  .instagram-fullheight-mode {
    position: fixed !important;
    top: 0 !important;
    left: 50% !important;
    transform: translateX(-50%) !important;
    width: 100% !important;
    max-width: 500px !important;
    height: 100vh !important;
    z-index: 9999 !important;
    background: black !important;
    display: flex !important;
    flex-direction: column !important;
    justify-content: center !important;
  }

  .instagram-fullheight-mode video,
  .instagram-fullheight-mode img {
    width: 100% !important;
    height: 100vh !important;
    object-fit: contain !important;
  }

  .instagram-overlay {
    position: fixed !important;
    top: 0 !important;
    left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    background: rgba(0, 0, 0, 0.9) !important;
    z-index: 9998 !important;
  }
`;
document.head.appendChild(style);

let fullHeightActive = false;
let overlay = null;

function toggleFullHeight() {
  // Find the main reel/post container
  const video = document.querySelector("video");
  if (!video) {
    console.log("No video found");
    return;
  }

  // Go up to find the card container (usually article or a div containing the whole post)
  let card = video.closest("article");
  if (!card) {
    // Try to find a container that looks like a card (has video and interaction buttons)
    let parent = video.parentElement;
    let depth = 0;
    while (parent && depth < 10) {
      if (
        parent.querySelector('[aria-label*="ike"]') &&
        parent.querySelector("video")
      ) {
        card = parent;
        break;
      }
      parent = parent.parentElement;
      depth++;
    }
  }

  if (!card) {
    console.log("Could not find card container");
    return;
  }

  if (!fullHeightActive) {
    // Create overlay
    overlay = document.createElement("div");
    overlay.className = "instagram-overlay";
    document.body.appendChild(overlay);

    // Apply full height class to card
    card.classList.add("instagram-fullheight-mode");
    card.dataset.originalStyle = card.getAttribute("style") || "";

    fullHeightActive = true;
    console.log("Entered full height mode");

    // Click overlay to exit
    overlay.onclick = function () {
      toggleFullHeight();
    };
  } else {
    // Exit full height mode
    const fullHeightCard = document.querySelector(".instagram-fullheight-mode");
    if (fullHeightCard) {
      fullHeightCard.classList.remove("instagram-fullheight-mode");
      if (fullHeightCard.dataset.originalStyle) {
        fullHeightCard.setAttribute(
          "style",
          fullHeightCard.dataset.originalStyle,
        );
      }
      delete fullHeightCard.dataset.originalStyle;
    }

    if (overlay) {
      overlay.remove();
      overlay = null;
    }

    fullHeightActive = false;
    console.log("Exited full height mode");
  }
}

// Keyboard event handler
document.addEventListener("keydown", function (event) {
  // Skip if user is typing
  if (
    event.target.tagName === "INPUT" ||
    event.target.tagName === "TEXTAREA" ||
    event.target.contentEditable === "true"
  ) {
    return;
  }

  // M - Toggle Mute
  if (event.key === "m" || event.key === "M") {
    event.preventDefault();
    const muteButton = document.querySelector(
      '[aria-label*="ute"], [aria-label*="udio"]',
    );
    if (muteButton) {
      const clickable =
        muteButton.closest('[role="button"]') || muteButton.parentElement;
      if (clickable) {
        clickable.click();
        console.log("Toggled mute");
      }
    }
  }

  // L - Like Post
  if (event.key === "l" || event.key === "L") {
    event.preventDefault();
    // Find the like button - look for "Gefällt mir" or "Like"
    const likeButtons = document.querySelectorAll(
      '[aria-label="Gefällt mir"], [aria-label="Like"], svg[aria-label="Gefällt mir"], svg[aria-label="Like"]',
    );
    for (let button of likeButtons) {
      const clickable = button.closest('[role="button"]');
      if (clickable && clickable.offsetParent !== null) {
        clickable.click();
        console.log("Liked post");
        break;
      }
    }
  }

  // C - Open Comments
  if (event.key === "c" || event.key === "C") {
    event.preventDefault();
    // Exit full height mode first if active
    if (fullHeightActive) {
      toggleFullHeight();
    }
    const commentButton = document.querySelector(
      '[aria-label*="omment"], [aria-label*="ommentar"]',
    );
    if (commentButton) {
      const clickable =
        commentButton.closest('[role="button"]') || commentButton.parentElement;
      if (clickable) {
        clickable.click();
        console.log("Opened comments");
      }
    }
  }

  // Arrow Up - Previous
  if (event.key === "ArrowUp") {
    // Exit full height mode first
    if (fullHeightActive) {
      toggleFullHeight();
    }
    const prevButton = document.querySelector(
      '[aria-label*="ack"], [aria-label*="urück"], [aria-label*="revious"]',
    );
    if (prevButton) {
      const clickable =
        prevButton.closest('[role="button"]') || prevButton.parentElement;
      if (clickable) {
        clickable.click();
        console.log("Navigated to previous");
        // Re-enable full height after navigation
        setTimeout(function () {
          if (!fullHeightActive) {
            toggleFullHeight();
          }
        }, 800);
      }
    }
  }

  // Arrow Down - Next
  if (event.key === "ArrowDown") {
    // Exit full height mode first
    if (fullHeightActive) {
      toggleFullHeight();
    }
    const nextButton = document.querySelector(
      '[aria-label*="ext"], [aria-label*="eiter"], [aria-label*="ächst"]',
    );
    if (nextButton) {
      const clickable =
        nextButton.closest('[role="button"]') || nextButton.parentElement;
      if (clickable) {
        clickable.click();
        console.log("Navigated to next");
        // Re-enable full height after navigation
        setTimeout(function () {
          if (!fullHeightActive) {
            toggleFullHeight();
          }
        }, 800);
      }
    }
  }

  // F - Toggle Full Height Mode
  if (event.key === "f" || event.key === "F") {
    event.preventDefault();
    toggleFullHeight();
  }

  // ESC - Exit full height mode
  if (event.key === "Escape" && fullHeightActive) {
    toggleFullHeight();
  }
});

console.log(
  "Instagram Power Mode v5.0 active - Shortcuts: M=mute, L=like, C=comments, F=full height, Arrows=navigate",
);
