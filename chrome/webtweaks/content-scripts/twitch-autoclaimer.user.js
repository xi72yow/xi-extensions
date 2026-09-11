// ==UserScript==
// @name        Twitch Auto Claimer
// @namespace   xi72yow
// @match       https://www.twitch.tv/*
// @grant       none
// @version 1.1
// @author      xi72yow
// @description Auto claim Twitch bonuses
// @downloadURL https://raw.githubusercontent.com/xi72yow/WebTweaks/master/scripts/twitch-autoclaimer.user.js
// @updateURL   https://raw.githubusercontent.com/xi72yow/WebTweaks/master/scripts/twitch-autoclaimer.user.js
// ==/UserScript==

let MutationObserver =
  window.MutationObserver ||
  window.WebKitMutationObserver ||
  window.MozMutationObserver;

let claiming = false;

if (MutationObserver) console.log("MutationObserver is supported");
else console.log("MutationObserver is not supported");

let observer = new MutationObserver((e) => {
  let bonus = document.querySelector(".claimable-bonus__icon");
  if (bonus && !claiming) {
    bonus.click();
    let date = new Date();
    claiming = true;
    setTimeout(() => {
      console.log("Claimed at " + date);
      claiming = false;
    }, Math.random() * 1000 + 2000);
  }
});

observer.observe(document.body, { childList: true, subtree: true });
