import * as idb from "./idbStorage.js";
import { ACTION_TAG_IDS } from "./tagHelper.js";
import { getUniqueMessageKey, log } from "./utils.js";

function _safeJson(v) {
  try {
    return JSON.parse(JSON.stringify(v));
  } catch (_) {
    return String(v);
  }
}

function _isMessageNotFoundError(e) {
  try {
    const s = String(e || "").toLowerCase();
    return s.includes("message not found");
  } catch (_) {
    return false;
  }
}

function _pickHeaderFields(h) {
  // Keep this intentionally small + stable so dumps are comparable across runs.
  return {
    id: h?.id ?? null,
    headerMessageId: h?.headerMessageId ?? null,
    subject: h?.subject ?? null,
    author: h?.author ?? null,
    recipients: Array.isArray(h?.recipients) ? h.recipients : null,
    ccList: Array.isArray(h?.ccList) ? h.ccList : null,
    bccList: Array.isArray(h?.bccList) ? h.bccList : null,
    date: h?.date ?? null,
    read: h?.read ?? null,
    flagged: h?.flagged ?? null,
    junk: h?.junk ?? null,
    tags: Array.isArray(h?.tags) ? h.tags : [],
    folder: h?.folder
      ? {
          id: h.folder.id ?? null,
          accountId: h.folder.accountId ?? null,
          name: h.folder.name ?? null,
          path: h.folder.path ?? null,
          type: h.folder.type ?? null,
          specialUse: Array.isArray(h.folder.specialUse) ? h.folder.specialUse : null,
        }
      : null,
  };
}

async function _dumpOneMessageById(weId, headerHint = null, source = "") {
  const id = Number(weId || 0);
  if (!id) return;

  const hintHeader = headerHint && headerHint.id === id ? headerHint : null;
  let liveHeader = null;
  let full = null;
  try {
    // IMPORTANT: selectedMessages headers can be stale (esp. around moves / IMAP sync).
    // Always prefer a fresh messages.get() result for "ground truth".
    liveHeader = await browser.messages.get(id);
  } catch (eGet) {
    const notFound = _isMessageNotFoundError(eGet);
    try {
      log(
        `[TMDBG DebugDump] messages.get failed id=${id} notFound=${notFound} source=${source || ""} err=${eGet}`,
        notFound ? "info" : "warn"
      );
    } catch (_) {}
  }

  try {
    full = await browser.messages.getFull(id);
  } catch (eFull) {
    const notFound = _isMessageNotFoundError(eFull);
    try {
      log(
        `[TMDBG DebugDump] messages.getFull failed id=${id} notFound=${notFound} source=${source || ""} err=${eFull}`,
        notFound ? "info" : "warn"
      );
    } catch (_) {}
  }

  let uniqueKey = null;
  try {
    uniqueKey = await getUniqueMessageKey(id);
  } catch (eKey) {
    try {
      log(`[TMDBG DebugDump] getUniqueMessageKey failed id=${id}: ${eKey}`, "warn");
    } catch (_) {}
  }

  const actionTagIds = Object.values(ACTION_TAG_IDS);
  const hintTags = Array.isArray(hintHeader?.tags) ? hintHeader.tags : [];
  const liveTags = Array.isArray(liveHeader?.tags) ? liveHeader.tags : [];
  const headerTags = liveTags;
  const hasActionTag = headerTags.some((t) => actionTagIds.includes(t));
  const actionTagsPresent = headerTags.filter((t) => actionTagIds.includes(t));

  const cacheKeys = uniqueKey
    ? [
        `summary:${uniqueKey}`,
        `summary:ts:${uniqueKey}`,
        `action:${uniqueKey}`,
        `action:ts:${uniqueKey}`,
        `action:orig:${uniqueKey}`,
        `action:justification:${uniqueKey}`,
        `action:userprompt:${uniqueKey}`,
        `reply:${uniqueKey}`,
        `reply:ts:${uniqueKey}`,
        `rootOverride:${uniqueKey}`,
      ]
    : [];

  let cacheDump = {};
  try {
    if (cacheKeys.length) {
      cacheDump = await idb.get(cacheKeys);
    }
  } catch (eCache) {
    try {
      log(`[TMDBG DebugDump] idb.get failed uniqueKey=${uniqueKey || ""}: ${eCache}`, "warn");
    } catch (_) {}
  }

  const dump = {
    meta: {
      source: source || "",
      ts: Date.now(),
    },
    derived: {
      uniqueKey,
      hasActionTag,
      actionTagsPresent,
    },
    header: liveHeader ? _pickHeaderFields(liveHeader) : null,
    headerHint: hintHeader ? _pickHeaderFields(hintHeader) : null,
    tagsCompare: {
      hintTags,
      liveTags,
    },
    full: full
      ? {
          // Avoid logging full body content; we only need headers/structure.
          headers: _safeJson(full.headers || null),
          contentType: full.contentType || null,
          partName: full.partName || null,
        }
      : null,
    idb: uniqueKey ? _safeJson(cacheDump) : null,
  };

  // Use console.log for the structured object (better than string truncation).
  try {
    console.log("[TMDBG DebugDump] message dump", dump);
  } catch (_) {}
  try {
    log(
      `[TMDBG DebugDump] dumped id=${id} uniqueKey=${uniqueKey || ""} liveTags=[${liveTags.join(
        ","
      )}] hintTags=[${hintTags.join(",")}] hasActionTag=${hasActionTag} actionTags=[${actionTagsPresent.join(
        ","
      )}] source=${source || ""}`
    );
  } catch (_) {}
}

/**
 * Dump selected message(s) debug info to the console.
 *
 * @param {Array<browser.messages.MessageHeader>} messageHeaders
 * @param {{source?: string}} [opts]
 */
export async function debugDumpSelectedMessages(messageHeaders, opts = {}) {
  const list = Array.isArray(messageHeaders) ? messageHeaders : [];
  const source = opts?.source || "";

  for (const h of list) {
    try {
      await _dumpOneMessageById(h?.id, h, source);
    } catch (e) {
      try {
        log(`[TMDBG DebugDump] dump failed id=${h?.id}: ${e}`, "warn");
      } catch (_) {}
    }
  }
}


