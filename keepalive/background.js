/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// keepalive/background.js
// Service Worker keepalive via periodic message pings from hidden relay page

// =============================================================================
// NO LISTENER NEEDED
// =============================================================================
// The relay sends periodic runtime.sendMessage() pings that reset the SW idle timer.
// We don't need to listen for them - unhandled messages are harmlessly ignored.
// The act of receiving the message is enough to keep the SW alive.

// =============================================================================
// INITIALIZATION
// =============================================================================

// Initialize experiment (injects hidden relay page into 3-pane windows)
console.log("[TMDBG KeepAlive] Initializing keepalive experiment...");
try {
  browser.tmKeepAlive.init();
  console.log("[TMDBG KeepAlive] Experiment initialized - hidden relay will be injected into 3-pane");
  console.log("[TMDBG KeepAlive] Service worker will stay alive via periodic message pings (always-on)");
} catch (e) {
  console.error("[TMDBG KeepAlive] Failed to initialize experiment:", e);
}
