/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

import { performTaggedAction } from "./action.js";

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
      _onTabPressedListener = () => {
        console.log("[TabMail TabKey] onTabPressed event received");
        handleTagActionKey();
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

async function handleTagActionKey() {
  try {
    const [activeTab] = await browser.mailTabs.query({ active: true });
    if (!activeTab) return;
    const selection = await browser.mailTabs.getSelectedMessages(activeTab.id);
    if (!selection || !selection.messages || selection.messages.length === 0) return;
    console.log(`[TabMail TabKey] Tab pressed – performing tagged action on ${selection.messages.length} message(s)`);
    const ops = selection.messages.map((msg) => performTaggedAction(msg));
    await Promise.all(ops);
    console.log("[TabMail TabKey] Tab press processing completed");
  } catch (_) {}
}
