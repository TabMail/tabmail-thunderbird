import { ACTION_TAG_IDS } from "./tagHelper.js";
import { SETTINGS } from "./config.js";
import { log } from "./utils.js";

function _arrayEqualAsSet(a, b) {
  try {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    if (aa.length !== bb.length) return false;
    for (const t of aa) {
      if (!bb.includes(t)) return false;
    }
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Clears TabMail action tags (tm_reply/tm_archive/tm_delete/tm_none) from a message.
 * This is used to clean up "phantom" or legacy tags, especially on self-sent messages.
 *
 * @param {number} weId - WebExtension message id
 * @param {string} reason - for logging
 * @param {browser.messages.MessageHeader|null} [headerHint=null] - optional already-fetched header
 * @returns {Promise<{cleared: boolean, removed: string[]}>}
 */
export async function clearTabMailActionTags(weId, reason = "", headerHint = null) {
  try {
    const id = Number(weId || 0);
    if (!id) return { cleared: false, removed: [] };

    const hdr = headerHint || (await browser.messages.get(id));
    const currentTags = Array.isArray(hdr?.tags) ? hdr.tags : [];
    const actionTagIds = Object.values(ACTION_TAG_IDS);
    const removed = currentTags.filter(t => actionTagIds.includes(t));
    if (removed.length === 0) return { cleared: false, removed: [] };

    const newTags = currentTags.filter(t => !actionTagIds.includes(t));
    if (_arrayEqualAsSet(currentTags, newTags)) return { cleared: false, removed: [] };

    try {
      if (SETTINGS?.actionTagging?.debugTagRace?.enabled === true) {
        let stack = "";
        try {
          const maxLinesRaw = SETTINGS?.actionTagging?.debugTagRace?.stackMaxLines;
          const maxLines = Number.isFinite(Number(maxLinesRaw)) ? Number(maxLinesRaw) : 0;
          const sliceCount = maxLines > 0 ? maxLines : 0;
          stack = String(new Error().stack || "")
            .split("\n")
            .slice(0, sliceCount)
            .join(" | ");
        } catch (_) {
          stack = "";
        }
        console.log(
          `[TMDBG TagRace] TagCleanup messages.update id=${id} reason=${reason || ""} before=[${currentTags.join(",")}] after=[${newTags.join(",")}] removed=[${removed.join(",")}] stack=${stack}`
        );
      }
    } catch (_) {}

    await browser.messages.update(id, { tags: newTags });
    try {
      log(`[TMDBG TagCleanup] Cleared TabMail tags: id=${id} removed=[${removed.join(",")}] reason=${reason || ""}`);
    } catch (_) {}
    return { cleared: true, removed };
  } catch (e) {
    try {
      log(`[TMDBG TagCleanup] Failed clearing TabMail tags for id=${weId}: ${e} reason=${reason || ""}`, "warn");
    } catch (_) {}
    return { cleared: false, removed: [] };
  }
}


