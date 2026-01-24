/**
 * Welcome wizard inline editor shortcut display
 */

export async function updateInlineEditorShortcut() {
  try {
    const shortcutSpan = document.getElementById("inline-editor-shortcut");
    if (!shortcutSpan) {
      console.warn("[Welcome] inline-editor-shortcut span not found");
      return;
    }

    let shortcutText;
    if (typeof browser !== "undefined" && browser.runtime && browser.runtime.getPlatformInfo) {
      const platformInfo = await browser.runtime.getPlatformInfo();
      const os = platformInfo?.os || "unknown";

      if (os === "mac") {
        // Mac: ⌘ (Command) + K
        shortcutText = "⌘K";
      } else {
        // Windows/Linux: ⌃ (Control) + K
        shortcutText = "⌃K";
      }
    } else {
      // Fallback: detect using navigator
      const isMac = navigator.platform.toUpperCase().indexOf("MAC") >= 0;
      shortcutText = isMac ? "⌘K" : "⌃K";
    }

    shortcutSpan.textContent = shortcutText;
    console.log(`[Welcome] Inline editor shortcut display updated: ${shortcutText}`);
  } catch (e) {
    console.warn(`[Welcome] Failed to update inline editor shortcut display: ${e}`);
    // Fallback: show ⌃K if detection fails
    const shortcutSpan = document.getElementById("inline-editor-shortcut");
    if (shortcutSpan) {
      shortcutSpan.textContent = "⌃K";
    }
  }
}

