console.log("[SpeedMatcher] 🚀 speed-rules-matcher.js EXECUTING 🚀");

/**
 * Shared speed rules matching logic
 * Used by both content script (video-speed.js) and popup (popup.js)
 */

/**
 * Get the speed for a given URL based on rules
 * @param {string} url - Full URL
 * @param {string} hostname - Hostname from URL
 * @param {Object} speedRules - Domain-based speed rules {domain: speed}
 * @param {Array} regexRules - Regex-based rules [{pattern, speed}]
 * @param {number} globalSpeed - Default global speed
 * @returns {Object} {speed: number, matchType: string, pattern: string}
 */
function getSpeedForUrl(url, hostname, speedRules, regexRules, globalSpeed) {
  // First check regex patterns (higher priority)
  for (const rule of regexRules) {
    try {
      const regex = new RegExp(rule.pattern);
      if (regex.test(url) || regex.test(hostname)) {
        return {
          speed: rule.speed,
          matchType: "regex",
          pattern: rule.pattern,
        };
      }
    } catch (e) {
      console.error("[SpeedMatcher] Invalid regex pattern:", rule.pattern);
    }
  }

  // Then check exact domain rules
  if (speedRules[hostname]) {
    return {
      speed: speedRules[hostname],
      matchType: "domain-exact",
      pattern: hostname,
    };
  }

  // Check if any parent domain has a rule (base domain matching)
  // e.g., "www.twitch.tv" rule matches "supervisor.ext-twitch.tv"
  // Both share the same root domain "twitch.tv" (last 2 parts)
  console.log("[SpeedMatcher] Checking base domain matching for:", hostname);

  // Extract the root domain from current hostname (last 2 parts)
  // e.g., "supervisor.ext-twitch.tv" -> ["supervisor", "ext-twitch", "tv"] -> "twitch.tv"
  const hostnameParts = hostname.split(".");
  const hostnameRoot =
    hostnameParts.length >= 2 ? hostnameParts.slice(-2).join(".") : hostname;

  console.log("[SpeedMatcher] Hostname root domain:", hostnameRoot);

  for (const domain in speedRules) {
    // Extract base domain from rule (e.g., "twitch.tv" from "www.twitch.tv")
    // Split by dots and take last 2 parts (domain.tld)
    const domainParts = domain.split(".");
    const baseDomain =
      domainParts.length >= 2 ? domainParts.slice(-2).join(".") : domain;

    console.log(
      "[SpeedMatcher] Testing rule:",
      domain,
      "-> baseDomain:",
      baseDomain,
      "| Comparing with hostnameRoot:",
      hostnameRoot,
      "->",
      hostnameRoot === baseDomain,
    );

    // Check if the root domains match
    // e.g., "twitch.tv" (from supervisor.ext-twitch.tv) === "twitch.tv" (from www.twitch.tv)
    if (
      hostnameRoot === baseDomain ||
      hostname === baseDomain ||
      hostname.endsWith("." + baseDomain)
    ) {
      console.log(
        "[SpeedMatcher] ✓ Base domain match:",
        hostname,
        "matches rule",
        domain,
        "(base:",
        baseDomain + ")",
      );
      return {
        speed: speedRules[domain],
        matchType: "domain-base",
        pattern: domain,
        baseDomain: baseDomain,
      };
    }
  }
  console.log("[SpeedMatcher] No base domain match found for:", hostname);

  // Default to global speed
  return {
    speed: globalSpeed,
    matchType: "global",
    pattern: "default",
  };
}

// Export for content scripts (global window object)
console.log("[SpeedMatcher] 📦 About to export to window.SpeedRulesMatcher...");
console.log("[SpeedMatcher] typeof window:", typeof window);

if (typeof window !== "undefined") {
  window.SpeedRulesMatcher = { getSpeedForUrl };
  console.log(
    "[SpeedMatcher] ✅ Exported! window.SpeedRulesMatcher:",
    window.SpeedRulesMatcher,
  );
} else {
  console.error("[SpeedMatcher] ❌ window is undefined!");
}
