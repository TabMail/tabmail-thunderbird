/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { performTaggedAction } from "./action.js";

// Keep this bound aligned with the parent keyOverride experiment.
const MAX_TAB_ACTION_MESSAGES = 100;
let _tabKeyRegistered = false;
let _onTabPressedListener = null;

export function cleanupTagActionKeyListeners() {
  if (_onTabPressedListener && browser.keyOverride?.onTabPressed) {
    try {
      browser.keyOverride.onTabPressed.removeListener(_onTabPressedListener);
      _onTabPressedListener = null;
      console.log("[TabMail TabKey] onTabPressed listener cleaned up");
    } catch (e) {
      console.error("[TabMail TabKey] Failed to remove onTabPressed listener:", e);
    }
  }
  _tabKeyRegistered = false;
}

export function registerTabKeyHandlers() {
  // Clean up existing listeners first
  cleanupTagActionKeyListeners();
  
  if (_tabKeyRegistered) return;
  try {
    if (browser.keyOverride && browser.keyOverride.onTabPressed) {
      console.log("[TabMail TabKey] Registering onTabPressed listener");
      
      // Store listener references
      _onTabPressedListener = info => {
        console.log("[TabMail TabKey] onTabPressed event received");
        if (!Array.isArray(info?.messageIds)) return;
        return handleTagActionKey(info?.messageIds);
      };
      browser.keyOverride.onTabPressed.addListener(_onTabPressedListener);
      
      _tabKeyRegistered = true;
    } else {
      console.warn("[TabMail TabKey] keyOverride.onTabPressed not available – Tab actions disabled");
    }
  } catch (e) {
    console.error("[TabMail TabKey] Error during registerTabKeyHandlers:", e);
  }
}

export async function triggerTagActionKey() {
  await handleTagActionKey();
}

async function handleTagActionKey(pressedMessageIds) {
  try {
    let messages;
    if (pressedMessageIds !== undefined) {
      if (!Array.isArray(pressedMessageIds) || !pressedMessageIds.length
          || pressedMessageIds.length > MAX_TAB_ACTION_MESSAGES
          || pressedMessageIds.some(id => !Number.isInteger(id) || id <= 0)) return;
      // The background may have slept since keydown. Never substitute the
      // current selection if a press-time target was deleted or moved.
      messages = await Promise.all([...new Set(pressedMessageIds)].map(id => browser.messages.get(id)));
      if (messages.some(msg => !msg)) return;
    } else {
      // Explicit programmatic trigger retains its current-selection behavior.
      const [activeTab] = await browser.mailTabs.query({ active: true });
      if (!activeTab) return;
      const selection = await browser.mailTabs.getSelectedMessages(activeTab.id);
      messages = selection?.messages || [];
    }
    if (!messages.length) return;
    console.log(`[TabMail TabKey] Tab pressed – performing tagged action on ${messages.length} message(s)`);
    const ops = messages.map(msg => performTaggedAction(msg));
    await Promise.all(ops);
    console.log("[TabMail TabKey] Tab press processing completed");
  } catch (_) {}
}
