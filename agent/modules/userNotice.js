import { log } from "./utils.js";
import { SETTINGS } from "./config.js";

function _notifId(prefix) {
  try {
    return `${prefix}:${Date.now()}:${Math.random().toString(16).slice(2)}`;
  } catch (_) {
    return `${prefix}:${Date.now()}`;
  }
}

let _cannotTagSelfWindowId = null;

async function showCannotTagSelfPopup(count) {
  try {
    // Reuse window if already open
    if (_cannotTagSelfWindowId != null) {
      try {
        await browser.windows.get(_cannotTagSelfWindowId);
        await browser.windows.update(_cannotTagSelfWindowId, { focused: true });
        return;
      } catch (_) {
        _cannotTagSelfWindowId = null;
      }
    }

    const url = browser.runtime.getURL(`agent/cannot-tag-self.html?count=${encodeURIComponent(String(count || 1))}`);
    const w = SETTINGS?.userNotice?.cannotTagSelf?.width || 420;
    const h = SETTINGS?.userNotice?.cannotTagSelf?.height || 240;
    const win = await browser.windows.create({
      url,
      type: "popup",
      width: w,
      height: h,
    });
    _cannotTagSelfWindowId = win?.id ?? null;
    try { log(`[UserNotice] cannotTagSelf popup opened windowId=${_cannotTagSelfWindowId}`); } catch (_) {}
  } catch (e) {
    try { log(`[UserNotice] cannotTagSelf popup failed: ${e}`, "warn"); } catch (_) {}
  }
}

export async function notifyCannotTagSelf({ count = 1 } = {}) {
  try {
    const title = "TabMail";
    const message =
      count > 1
        ? `These ${count} messages are from you! TabMail does not classify your own emails — you know best!`
        : "This message is from you! TabMail does not classify your own emails — you know best!";

    // Prefer in-app popup (reliable even when OS notifications are suppressed).
    await showCannotTagSelfPopup(count);

    const id = _notifId("tabmail:cannot-tag-self");
    await browser.notifications.create(id, {
      type: "basic",
      title,
      message,
      iconUrl: "icons/tab.svg",
    });
    try { log(`[UserNotice] notifyCannotTagSelf shown id=${id} count=${count}`); } catch (_) {}
  } catch (e) {
    // Notifications are user-visible; if they fail, still log for debugging.
    try { log(`[UserNotice] notifyCannotTagSelf failed: ${e}`, "warn"); } catch (_) {}
  }
}


