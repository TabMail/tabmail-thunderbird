/**
 * tagDefs.js — Tag constants, definitions, priority logic, and setup.
 * Foundational module with no dependencies on other tag* modules.
 */

import { SETTINGS } from "./config.js";
import { getTAG_COLORS } from "../../theme/palette/palette.js";

// ---------------------------------------------------------------------------
// Action tag IDs & keys
// ---------------------------------------------------------------------------

export const ACTION_TAG_IDS = {
  delete: "tm_delete",
  archive: "tm_archive",
  reply: "tm_reply",
  none: "tm_none",
};

export const ACTION_TAG_KEYS = new Set(Object.values(ACTION_TAG_IDS));

// ---------------------------------------------------------------------------
// Sort trigger & debug config
// ---------------------------------------------------------------------------

// Simple trigger for tagSort.refresh() - the delayed sort mechanism in tagSort
// handles debouncing, coalescing, and checking if sorting is actually needed.
// Also triggers tag coloring refresh.
export function triggerSortRefresh() {
  try {
    if (browser.tagSort && browser.tagSort.refresh) {
      console.log("[TMDBG Tag] Triggering tagSort.refresh() (delayed sort will handle timing)");
      browser.tagSort.refresh();
    } else {
      console.log("[TMDBG Tag] tagSort API not available.");
    }
  } catch (e) {
    console.error("[TMDBG Tag] Error triggering tagSort.refresh():", e);
  }
  // Tag coloring experiment deprecated - native TB colors used instead
  // TM tag sorting still works correctly via tagSort.refresh()
}

export function isDebugTagRaceEnabled() {
  return SETTINGS?.actionTagging?.debugTagRace?.enabled === true;
}

// ---------------------------------------------------------------------------
// Action priority logic
// ---------------------------------------------------------------------------

function _getActionPriorityMap() {
  return SETTINGS?.actionTagging?.actionPriority || {};
}

function _priorityForAction(action) {
  try {
    const p = _getActionPriorityMap()[action];
    return Number.isFinite(p) ? p : -1;
  } catch (_) {
    return -1;
  }
}

export function maxPriorityAction(actions) {
  try {
    const list = Array.isArray(actions) ? actions.filter(Boolean).map(String) : [];
    let best = null;
    let bestP = -1;
    for (const a of list) {
      const p = _priorityForAction(a);
      if (p > bestP) {
        bestP = p;
        best = a;
      }
    }
    return best;
  } catch (_) {
    return null;
  }
}

export function actionFromLiveTagIds(tags) {
  try {
    const list = Array.isArray(tags) ? tags : [];
    // Reverse lookup: tm_* tag id -> action name
    const candidates = [];
    for (const [action, tagId] of Object.entries(ACTION_TAG_IDS || {})) {
      if (list.includes(tagId)) candidates.push(action);
    }
    if (candidates.length === 0) return null;
    return maxPriorityAction(candidates);
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Tag reordering utilities
// ---------------------------------------------------------------------------

export function reorderTagsToPreferTabMail(tags) {
  const list = Array.isArray(tags) ? tags.filter(Boolean) : [];
  if (list.length <= 1) return list;

  // Keep relative order of non-TabMail tags, but move TabMail action tags to the front.
  const tm = [];
  const other = [];
  for (const t of list) {
    if (ACTION_TAG_KEYS.has(t)) tm.push(t);
    else other.push(t);
  }
  // If no TabMail tag present, keep original ordering.
  if (!tm.length) return list;
  return tm.concat(other);
}

export function hasNonTabMailTags(tags) {
  const list = Array.isArray(tags) ? tags : [];
  for (const t of list) {
    if (!t) continue;
    if (!ACTION_TAG_KEYS.has(t)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Tag definitions (colors from palette) & ensureActionTags
// ---------------------------------------------------------------------------

let TAG_DEFS = null;

// Lazy initialize TAG_DEFS from async palette data
async function getTagDefs() {
  if (TAG_DEFS) return TAG_DEFS;
  const TAG_COLORS = await getTAG_COLORS();
  TAG_DEFS = {
    // Tag naming:
    // - Sorting is now done via TagSort's custom DBView sort key (byCustom), so we no longer
    //   need name hacks like "zz " or numeric prefixes for ordering.
    tm_reply:   { tag: "TabMail Reply",   color: TAG_COLORS.tm_reply },
    tm_none:    { tag: "TabMail None",    color: TAG_COLORS.tm_none },
    tm_archive: { tag: "TabMail Archive", color: TAG_COLORS.tm_archive },
    tm_delete:  { tag: "TabMail Delete",  color: TAG_COLORS.tm_delete },
  };
  return TAG_DEFS;
}

let _tagsEnsured = false;

export async function ensureActionTags() {
  const TAG_DEFS = await getTagDefs();
  if (_tagsEnsured) return;
  if (!browser.messages || !browser.messages.tags || !browser.messages.tags.list) {
    // log('[TMDBG Tag] messages.tags API not available – cannot ensure action tags.');
    return;
  }
  const existing = await browser.messages.tags.list();
  for (const [id, def] of Object.entries(TAG_DEFS)) {
    const current = existing.find(t => t.key === id);

    // Create new tag if it does not exist.
    if (!current) {
      try {
        await browser.messages.tags.create(id, def.tag, def.color);
        // log(`[TMDBG Tag] Created tag ${def.tag}`);
      } catch (e) {
        // log(`[TMDBG Tag] Failed to create tag ${id}: ${e}`, 'error');
      }
      continue;
    }

    // Update tag if name or color changed.
    const currentColor = current.color || "";
    const defColor = def.color || "";
    const needsUpdate = current.tag !== def.tag || currentColor.toUpperCase() !== defColor.toUpperCase();
    if (needsUpdate) {
      try {
        await browser.messages.tags.update(id, { tag: def.tag, color: def.color });
        // log(`[TMDBG Tag] Updated tag ${id} -> '${def.tag}' ${def.color ? `(${def.color})` : '(no color)' }`);
      } catch (e) {
        // log(`[TMDBG Tag] Failed to update tag ${id}: ${e}`, 'error');
      }
    }
  }
  _tagsEnsured = true;
}
