import { performTaggedAction } from "./action.js";

let _tabKeyRegistered = false;
let _onTabPressedListener = null;
let _onShiftTabPressedListener = null;

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
  if (_onShiftTabPressedListener && browser.keyOverride?.onShiftTabPressed) {
    try {
      browser.keyOverride.onShiftTabPressed.removeListener(_onShiftTabPressedListener);
      _onShiftTabPressedListener = null;
      console.log("[TabMail TabKey] onShiftTabPressed listener cleaned up");
    } catch (e) {
      console.error("[TabMail TabKey] Failed to remove onShiftTabPressed listener:", e);
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
      console.log("[TabMail TabKey] Registering onTabPressed and onShiftTabPressed listeners");
      
      // Store listener references
      _onTabPressedListener = () => {
        console.log("[TabMail TabKey] onTabPressed event received");
        handleTagActionKey();
      };
      browser.keyOverride.onTabPressed.addListener(_onTabPressedListener);
      
      try {
        if (browser.keyOverride && browser.keyOverride.onShiftTabPressed) {
          _onShiftTabPressedListener = () => {
            console.log("[TabMail TabKey] onShiftTabPressed event received");
            handleShiftTabPressed();
          };
          browser.keyOverride.onShiftTabPressed.addListener(_onShiftTabPressedListener);
        } else {
          console.warn("[TabMail TabKey] onShiftTabPressed not available on keyOverride API");
        }
      } catch (e) {
        console.error("[TabMail TabKey] Failed to register onShiftTabPressed:", e);
      }
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

async function handleShiftTabPressed() {
  try {
    const [activeTab] = await browser.mailTabs.query({ active: true });
    if (!activeTab) return;
    const selection = await browser.mailTabs.getSelectedMessages(activeTab.id);
    if (!selection || !selection.messages || selection.messages.length === 0) return;
    // console.log(`[TabMail TabKey] Shift+Tab – setting action 'none' on ${selection.messages.length} message(s)`);
    console.log(`[TabMail TabKey] Shift+Tab called, but disabled for now.`);
    // const ops = selection.messages.map(async (msg) => {
    //   try {
    //     await applyPriorityTag(msg.id, "none");
    //     // Fire-and-forget the prompt update; do not await
    //     try { autoUpdateUserPromptOnTag(msg.id, "none", { source: "hotkey" }); } catch (_) {}
    //   } catch (err) {
    //     console.error(`[TabMail TabKey] Failed to apply 'none' to message ${msg?.id}:`, err);
    //   }
    // });
    // await Promise.all(ops);
    console.log("[TabMail TabKey] Shift+Tab processing completed");
  } catch (e) {
    console.error("[TabMail TabKey] Error in handleShiftTabPressed:", e);
  }
}


