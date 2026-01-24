const { ExtensionCommon: ExtensionCommonGloda } = ChromeUtils.importESModule(
  "resource://gre/modules/ExtensionCommon.sys.mjs"
);
let ServicesGS = null;
try {
  ({ Services: ServicesGS } = ChromeUtils.importESModule("resource://gre/modules/Services.sys.mjs"));
} catch (_) {
  try { ServicesGS = globalThis.Services; } catch (_) { ServicesGS = null; }
}

// Gloda public API imports (TB 128+/140+ ESM)
let Gloda = null;
let GlodaConstants = null;
try {
  ({ Gloda } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaPublic.sys.mjs"));
} catch (e1) {
  console.error("[glodaSearch] Failed to import Gloda module GlodaPublic.sys.mjs:", e1);
}
try {
  ({ GlodaConstants } = ChromeUtils.importESModule("resource:///modules/gloda/GlodaConstants.sys.mjs"));
} catch (e2) {
  console.error("[glodaSearch] Failed to import GlodaConstants.sys.mjs:", e2);
}

// Helper: convert JS Date or ISO string to epoch ms; returns null on failure.
function toMs(d) {
  if (!d) return null;
  if (typeof d === "number" && Number.isFinite(d)) return d;
  const t = new Date(d).getTime();
  return Number.isFinite(t) ? t : null;
}

// Fast-path debug guard
const DEBUG_GLODA_FAST = false;

var GLODA_CONV_CONFIG = {
  maxConversationMessages: 50,
};

async function getConversationMessagesImpl(context, weMsgId, options = {}) {
  try {
    console.log(`[glodaConversation] called weMsgId=${weMsgId} opts=${JSON.stringify(options || {})}`);

    if (!Number.isFinite(weMsgId) || weMsgId < 0) {
      return { success: false, error: "Invalid weMsgId", messages: [] };
    }

    if (!Gloda || !GlodaConstants) {
      console.error("[glodaConversation] Gloda/GlodaConstants unavailable");
      return { success: false, error: "Gloda unavailable", messages: [] };
    }

    const msgMgr = context.extension.messageManager;
    if (!msgMgr) {
      return { success: false, error: "messageManager not available", messages: [] };
    }

    let hdr = null;
    try {
      hdr = msgMgr.get(weMsgId);
    } catch (e) {
      return { success: false, error: `messageManager.get failed: ${e}`, messages: [] };
    }
    if (!hdr) {
      return { success: false, error: "Native header not found", messages: [] };
    }

    const maxMessages = options?.maxMessages || GLODA_CONV_CONFIG.maxConversationMessages;

    // Convert header -> Gloda message (noun_message) via Gloda helper.
    const glodaMessage = await new Promise((resolve) => {
      try {
        if (typeof Gloda.getMessageCollectionForHeaders !== "function") {
          console.error("[glodaConversation] Gloda.getMessageCollectionForHeaders not available");
          resolve(null);
          return;
        }
        Gloda.getMessageCollectionForHeaders([hdr], {
          onItemsAdded() {},
          onItemsModified() {},
          onItemsRemoved() {},
          onQueryCompleted(collection) {
            try {
              const it = collection?.items?.[0] || null;
              resolve(it);
            } catch (_) {
              resolve(null);
            }
          },
        });
      } catch (e) {
        console.error("[glodaConversation] getMessageCollectionForHeaders threw", e);
        resolve(null);
      }
    });

    if (!glodaMessage) {
      return { success: true, messages: [] };
    }

    // Discover conversation object.
    let conv = null;
    try {
      conv = glodaMessage.conversation || glodaMessage._conversation || null;
    } catch (_) {}

    if (!conv) {
      try {
        const keys = Object.keys(glodaMessage || {}).slice(0, 40);
        console.warn("[glodaConversation] glodaMessage has no conversation; keys:", keys.join(","));
      } catch (_) {}
      return { success: true, messages: [] };
    }

    // Attempt to extract a stable conversation identifier for downstream consumers.
    // This lets MV3 code store per-thread aggregates keyed by Gloda conversation.
    let conversationId = "";
    try {
      const raw =
        conv?.id ??
        conv?._id ??
        conv?.conversationID ??
        conv?._conversationID ??
        conv?.conversationId ??
        conv?._conversationId ??
        null;
      if (raw != null) conversationId = String(raw);
    } catch (_) {
      conversationId = "";
    }
    if (!conversationId) {
      try {
        const ckeys = Object.keys(conv || {}).slice(0, 40);
        console.warn("[glodaConversation] conversationId unavailable; conv keys:", ckeys.join(","));
      } catch (_) {}
    }

    // Query all messages in the conversation.
    const query = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE);
    let applied = false;
    try {
      const hasConv = typeof query.conversation === "function";
      const hasInConv = typeof query.inConversation === "function";
      console.log(`[glodaConversation] query helpers: conversation=${hasConv} inConversation=${hasInConv} orderBy=${typeof query.orderBy === "function"} limit=${typeof query.limit === "function"}`);
      if (hasConv) {
        query.conversation(conv);
        applied = true;
      } else if (hasInConv) {
        query.inConversation(conv);
        applied = true;
      }
    } catch (e) {
      console.error("[glodaConversation] failed applying conversation constraint", e);
    }

    if (!applied) {
      return { success: false, error: "Gloda query has no conversation constraint helper", messages: [] };
    }

    try { if (typeof query.orderBy === "function") query.orderBy("-date"); } catch (_) {}
    try { if (typeof query.limit === "function" && Number.isFinite(maxMessages) && maxMessages > 0) query.limit(maxMessages); } catch (_) {}

    const items = await new Promise((resolve) => {
      try {
        query.getCollection({
          onItemsAdded() {},
          onItemsModified() {},
          onItemsRemoved() {},
          onQueryCompleted(collection) {
            resolve(collection?.items ?? []);
          },
        });
      } catch (e) {
        console.error("[glodaConversation] query.getCollection threw", e);
        resolve([]);
      }
    });

    console.log(`[glodaConversation] conversation items=${items.length}`);

    const out = [];
    for (const it of items) {
      try {
        const mHdr = it.folderMessage || it._message || null;
        const weMsg    = mHdr ? context.extension.messageManager.convert(mHdr) : null;
        const weFolder = mHdr?.folder ? context.extension.folderManager.convert(mHdr.folder) : null;
        const subject  = String(it._subject || it.subject || mHdr?.mime2DecodedSubject || "");
        const author   = String(it._from    || it.from    || mHdr?.author || "");
        const dateMs   = (it?.date && typeof it.date.getTime === 'function') ? it.date.getTime() : (Number(new Date(it?.date || mHdr?.date).getTime()) || 0);
        out.push({
          headerMessageId: String(mHdr?.messageId || ""),
          weMsgId: weMsg?.id ?? null,
          weFolderId: weFolder?.id ?? null,
          msgKey: Number.isFinite(mHdr?.messageKey) ? Number(mHdr.messageKey) : NaN,
          subject,
          author,
          dateMs,
          folderUri: mHdr?.folder?.URI || mHdr?.folder?.uri || "",
        });
      } catch (_) {
        // continue
      }
    }

    return { success: true, conversationId, messages: out };
  } catch (e) {
    console.error("[glodaConversation] getConversationMessagesImpl failed", e);
    return { success: false, error: String(e), messages: [] };
  }
}

// --- utility: micro-yield to keep UI responsive (TB chrome context)
async function microYield() {
  try {
    if (ServicesGS?.tm?.dispatchToMainThread) {
      return await new Promise((res) => ServicesGS.tm.dispatchToMainThread(res));
    }
  } catch (_) {}
  try { console.warn("[glodaSearchFast] microYield: dispatchToMainThread not available; skipping yield"); } catch(_) {}
  return Promise.resolve();
}

// --- Pass A: date-only, index-backed
async function glodaDateOnly(context, fromIso, toIso, cap = 2500, folderObjs = null) {
  try {
    const q = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE);
    const toMsLocal = (d) => {
      if (d == null || d === "") return null;
      if (typeof d === "number" && Number.isFinite(d)) return d;
      const t = new Date(d).getTime();
      return Number.isFinite(t) ? t : null;
    };
    let loMs = toMsLocal(fromIso);
    let hiMs = toMsLocal(toIso);
    let lo = loMs != null ? new Date(loMs) : new Date(0);
    let hi = hiMs != null ? new Date(hiMs) : new Date(8640000000000000);
    if (lo > hi) [lo, hi] = [hi, lo];
    if (DEBUG_GLODA_FAST) {
      try { console.log(`[glodaSearchFast] date-only window lo=${lo.toISOString()} hi=${Number.isFinite(hi.getTime()) ? hi.toISOString() : 'n/a'} cap=${cap}`); } catch(_) {}
    }
    if (q.dateRange) q.dateRange([lo, hi]);
    // Optional folder scoping
    try { if (folderObjs && Array.isArray(folderObjs) && q.inFolder) { for (const f of folderObjs) q.inFolder(f); } } catch(_) {}
    if (q.orderBy) q.orderBy("-date");
    if (q.limit)   q.limit(cap);

    const col = await new Promise((res) => q.getCollection({
      onItemsAdded() {}, onItemsModified() {}, onItemsRemoved() {},
      onQueryCompleted(c) { res(c); },
    }));
    const items = col?.items ?? [];
    if (DEBUG_GLODA_FAST) try { console.log(`[glodaSearchFast] date-only pass returned items=${items.length}`); } catch(_) {}

    const rows = [];
    for (const it of items) {
      const hdr = it.folderMessage || it._message || null;
      const weMsg    = hdr ? context.extension.messageManager.convert(hdr) : null;
      const weFolder = hdr?.folder ? context.extension.folderManager.convert(hdr.folder) : null;
      const subject  = String(it._subject || it.subject || hdr?.mime2DecodedSubject || "");
      const author   = String(it._from    || it.from    || hdr?.author || "");
      const dateMs   = (it?.date && typeof it.date.getTime === 'function') ? it.date.getTime() : (Number(new Date(it?.date || hdr?.date).getTime()) || 0);
      rows.push({
        headerId: hdr?.messageId || "", headerMessageId: hdr?.messageId || "",
        weMsgId: weMsg?.id ?? null, weFolderId: weFolder?.id ?? null,
        msgKey: Number.isFinite(hdr?.messageKey) ? Number(hdr.messageKey) : NaN,
        subject, author, dateMs,
        folderUri: hdr?.folder?.URI || hdr?.folder?.uri || "",
      });
    }
    return rows;
  } catch (e) {
    console.warn("[glodaSearchFast] glodaDateOnly failed", e);
    return [];
  }
}

// --- Pass B: keyset-paginated FTS within the same window (supports AND terms + optional phrase)
async function ftsKeysetPaged({ terms = [], phrase = "", text = "", lo, hi, pageSize = 300, maxTotal = 200, folderObjs = null }) {
  const hits = [];
  const seen = new Set();
  const toValidDate = (input) => {
    if (input == null || input === "") return null;
    if (input instanceof Date) {
      const t = input.getTime();
      return Number.isFinite(t) ? input : null;
    }
    const t = new Date(input).getTime();
    return Number.isFinite(t) ? new Date(t) : null;
  };
  const loDate = toValidDate(lo) ?? new Date(0);
  let cursorHi = toValidDate(hi) ?? new Date(8640000000000000); // +Inf

  if (DEBUG_GLODA_FAST) {
    try {
      const _tPreview = Array.isArray(terms) && terms.length ? `terms=${terms.length}` : `text='${String(text||'').slice(0,80)}'`;
      const _pPreview = phrase ? ` phrase='${String(phrase).slice(0,80)}'` : '';
      console.log(`[glodaSearchFast] FTS window init lo=${loDate.toISOString()} hi=${Number.isFinite(cursorHi.getTime()) ? cursorHi.toISOString() : 'n/a'} ${_tPreview}${_pPreview} pageSize=${pageSize} maxTotal=${maxTotal}`);
    } catch(_) {}
  }

  while (hits.length < maxTotal) {
    const items = await new Promise((res) => {
      const q = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE);
      const hasDateRange = typeof q.dateRange === 'function';
      const hasFts = typeof q.fulltextMatches === 'function';
      if (hasDateRange) q.dateRange([loDate, cursorHi]);
      if (hasFts) {
        try {
          if (Array.isArray(terms)) {
            for (const t of terms) {
              if (typeof t === 'string' && t.trim()) q.fulltextMatches(t.trim());
            }
          }
          const _phrase = typeof phrase === 'string' ? phrase.trim() : '';
          if (_phrase) q.fulltextMatches(_phrase);
          if ((!terms || terms.length === 0) && !phrase && text) q.fulltextMatches(text);
        } catch (e) {
          try { console.warn('[glodaSearchFast] fulltextMatches apply failed', e); } catch(_) {}
        }
      }
      try { if (folderObjs && Array.isArray(folderObjs) && q.inFolder) { for (const f of folderObjs) q.inFolder(f); } } catch(_) {}
      if (q.orderBy) q.orderBy("-date");
      if (q.limit)   q.limit(pageSize);
      q.getCollection({
        onItemsAdded() {}, onItemsModified() {}, onItemsRemoved() {},
        onQueryCompleted(c) { res(c?.items ?? []); },
      });
    });

    if (!items.length) {
      if (DEBUG_GLODA_FAST) {
        try { console.log(`[glodaSearchFast] page empty; stop. window lo=${loDate.toISOString()} hi=${Number.isFinite(cursorHi.getTime()) ? cursorHi.toISOString() : 'n/a'}`); } catch(_) {}
      }
      break;
    }

    let oldest = null;
    let pageCount = 0;
    for (const it of items) {
      const hdr = it.folderMessage || it._message || null;
      const key = hdr?.messageId || (hdr?.folder?.URI + ":" + hdr?.messageKey);
      if (!key) continue;
      const t = (it?.date && typeof it.date.getTime === 'function') ? it.date.getTime() : (Number(new Date(it?.date || hdr?.date).getTime()) || 0);
      if (oldest === null || t < oldest) oldest = t;
      if (seen.has(key)) continue;
      seen.add(key);
      hits.push(it);
      pageCount += 1;
      if (hits.length >= maxTotal) break;
    }

    if (DEBUG_GLODA_FAST) try { console.log(`[glodaSearchFast] page collected=${pageCount} total=${hits.length} nextCursorHi=${oldest != null ? new Date(oldest - 1).toISOString() : 'n/a'}`); } catch(_) {}

    if (oldest === null) break;
    cursorHi = new Date(oldest - 1); // keyset step
    await microYield();
  }
  return hits;
}

function parseQueryToTermsAndPhrase(q) {
  const text = String(q || "");
  if (!text) return { terms: [], phrase: "" };
  let phrase = "";
  try {
    const m = text.match(/"([^"]+)"/);
    if (m && m[1]) phrase = m[1].trim();
  } catch (_) {}
  let remainder = text;
  try { remainder = text.replace(/"[^"]+"/g, " "); } catch (_) {}
  const terms = remainder
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
  return { terms, phrase };
}

// --- Public fast entry (single-string query -> tokens+phrase, two-stage)
async function searchMessagesQueryImpl(context, queryText, fromIso, toIso, limit = 200, ignoreDate = false) {
  try {
    if (DEBUG_GLODA_FAST) try { console.log(`[glodaSearchQuery] called q='${String(queryText||'').slice(0,80)}' from='${fromIso||''}' to='${toIso||''}' limit=${limit} ignoreDate=${!!ignoreDate}`); } catch(_) {}

    // Pass A: date-only
    const candidates = await glodaDateOnly(context, ignoreDate ? null : fromIso, ignoreDate ? null : toIso, 2500 /*cap*/, /*folderObjs*/ null);
    if (DEBUG_GLODA_FAST) try { console.log(`[glodaSearchQuery] date-only candidates=${candidates.length}`); } catch(_) {}

    const q = String(queryText || "").trim();
    const { terms, phrase } = parseQueryToTermsAndPhrase(q);
    try { console.log(`[glodaSearchQuery] parsed terms=${terms.length} phrase='${(phrase||'').slice(0,80)}'`); } catch(_) {}
    if (!q || (terms.length === 0 && !phrase)) return candidates.slice(0, Number(limit) || 200);
    if (DEBUG_GLODA_FAST) try { console.log(`[glodaSearchQuery] using keyset-paginated FTS (candidates=${candidates.length}) terms=${terms.length} phraseLen=${phrase ? phrase.length : 0}`); } catch(_) {}

    // Pass B: keyset-paginated FTS constrained by same window
    const paged = await ftsKeysetPaged({
      terms, phrase, lo: ignoreDate ? null : fromIso, hi: ignoreDate ? null : toIso,
      pageSize: 300, maxTotal: Number(limit) || 200,
      folderObjs: null,
    });

    // Map to lightweight rows
    const out = [];
    for (const it of paged) {
      const hdr = it.folderMessage || it._message || null;
      const weMsg    = hdr ? context.extension.messageManager.convert(hdr) : null;
      const weFolder = hdr?.folder ? context.extension.folderManager.convert(hdr.folder) : null;
      const subject  = String(it._subject || it.subject || hdr?.mime2DecodedSubject || "");
      const author   = String(it._from    || it.from    || hdr?.author || "");
      const dateMs   = (it?.date && typeof it.date.getTime === 'function') ? it.date.getTime() : (Number(new Date(it?.date || hdr?.date).getTime()) || 0);
      out.push({
        headerId: hdr?.messageId || "", headerMessageId: hdr?.messageId || "",
        weMsgId: weMsg?.id ?? null, weFolderId: weFolder?.id ?? null,
        msgKey: Number.isFinite(hdr?.messageKey) ? Number(hdr.messageKey) : NaN,
        subject, author, dateMs,
        folderUri: hdr?.folder?.URI || hdr?.folder?.uri || "",
      });
    }
    return out;
  } catch (e) {
    console.error("[glodaSearchQuery] searchMessagesQueryImpl failed", e);
    return [];
  }
}

async function glodaQueryInternal(context, q, fromIso, toIso, limit, folderUris, ignoreDate) {
  if (!Gloda || !GlodaConstants) {
    console.error("[glodaSearch] Gloda/GlodaConstants unavailable");
    return [];
  }

  try {
    const query = Gloda.newQuery(GlodaConstants.NOUN_MESSAGE);
    try {
      console.log(
        `[glodaSearch] newQuery ok → has fulltextMatches=${typeof query.fulltextMatches === 'function'} dateHelper=${typeof query.date === 'function'} dateRangeHelper=${typeof query.dateRange === 'function'} dateRangeArity=${typeof query.dateRange === 'function' ? query.dateRange.length : 'n/a'} orderByHelper=${typeof query.orderBy === 'function'} limitHelper=${typeof query.limit === 'function'}`
      );
      try {
        const dateKeys = Object.keys(query).filter(k => /date/i.test(k));
        console.log(`[glodaSearch] query keys with 'date': ${dateKeys.map(k => `${k}:${typeof query[k]}`).join(', ')}`);
      } catch(_) {}
    } catch(_) {}
    try {
      if (ServicesGS?.prefs) {
        const idxOn = ServicesGS.prefs.getBoolPref("mailnews.database.global.indexer.enabled", true);
        console.log(`[glodaSearch] pref mailnews.database.global.indexer.enabled=${idxOn}`);
      }
    } catch(_) {}

    // Fulltext
    if (q && typeof query.fulltextMatches === "function") {
      try { console.log(`[glodaSearch] applying fulltextMatches for q='${String(q).slice(0,80)}'`); } catch(_) {}
      query.fulltextMatches(q);
    } else {
      try { console.warn(`[glodaSearch] fulltextMatches not available on query – skipping text constraint`); } catch(_) {}
    }

    // Date range via Gloda helper: expects JS Date objects, and BOTH bounds. Fill missing with sentinels.
    const fromMs = toMs(fromIso);
    const toMsVal = toMs(toIso);
    if (!ignoreDate && (fromMs != null || toMsVal != null)) {
      try {
        const hasDateRangeHelper = typeof query.dateRange === "function";
        let lo = (fromMs != null) ? new Date(fromMs) : new Date(0);
        let hi = (toMsVal != null) ? new Date(toMsVal) : new Date(8640000000000000);
        if (lo > hi) [lo, hi] = [hi, lo];
        try { console.log(`[glodaSearch] applying date filter lo=${lo.toISOString()} hi=${hi.toISOString()} usingDateRange=${hasDateRangeHelper}`); } catch(_) {}
        if (hasDateRangeHelper) {
          // Pass a single [lo, hi] pair; some builds expect an array of ranges.
          query.dateRange([lo, hi]);
        } else {
          console.warn(`[glodaSearch] dateRange helper missing – skipping date constraint`);
        }
      } catch (drErr) {
        console.warn("[glodaSearch] date range apply failed", drErr);
      }
    } else if (ignoreDate) {
      try { console.log(`[glodaSearch] ignoring date filter for diagnostics`); } catch(_) {}
    }

    // Folder scoping (optional). Gloda wants nsIMsgFolder; resolve via RDF if needed is heavy,
    // so for v1 we skip folder constraint and rely on Gloda’s global index.
    // If strict scoping is required later, add nsIMsgFolder resolution here.

    // Apply ordering before limit so top-N is deterministic.
    try {
      const hasOrder = typeof query.orderBy === 'function';
      console.log(`[glodaSearch] applying orderBy '-date' (if available) hasOrder=${hasOrder}`);
      if (hasOrder) {
        try { query.orderBy('-date'); } catch (obErr) { console.warn(`[glodaSearch] orderBy failed`, obErr); }
      }
    } catch(_) {}

    if (Number.isFinite(limit) && limit > 0) {
      try {
        const hasLim = typeof query.limit === 'function';
        if (hasLim) {
          query.limit(limit);
          try { console.log(`[glodaSearch] limit applied=${limit}`); } catch(_) {}
        } else {
          try { console.warn(`[glodaSearch] query.limit not available`); } catch(_) {}
        }
      } catch (_) {}
    }

    const collector = [];
    // Execute query via Gloda’s async API with an explicit listener.
    const result = await new Promise((resolve) => {
      try {
        const listener = {
          onItemsAdded(_items, _collection) {},
          onItemsModified(_items, _collection) {},
          onItemsRemoved(_items, _collection) {},
          onQueryCompleted(collection) { try { console.log(`[glodaSearch] onQueryCompleted fired`); } catch(_) {} resolve(collection); },
        };
        query.getCollection(listener);
      } catch (e) {
        console.error("[glodaSearch] query.getCollection threw", e);
        resolve(null);
      }
    });

    if (!result || !result.items) {
      console.warn("[glodaSearch] empty result or missing items");
      return [];
    }
    try { console.log(`[glodaSearch] onQueryCompleted: items=${result.items.length}`); } catch(_) {}

    for (const item of result.items) {
      try {
        const hdr = item && (item.folderMessage || item._message) || null;
        const subject = String((item && (item._subject || item.subject)) || (hdr && hdr.mime2DecodedSubject) || "");
        const author = String((item && (item._from || item.from)) || (hdr && hdr.author) || "");
        const dateMs = (() => {
          try {
            const d = item && item.date || hdr && hdr.date;
            if (!d) return 0;
            if (typeof d === "number") return d;
            if (d && typeof d.getTime === "function") return d.getTime();
            return Number(new Date(d).getTime()) || 0;
          } catch (_) { return 0; }
        })();
        const folderUri = (() => { try { return String(hdr?.folder?.URI || hdr?.folder?.uri || ""); } catch(_) { return ""; }})();
        const headerMessageId = (() => { try { return String(hdr?.messageId || ""); } catch(_) { return ""; }})();

        // Per-folder numeric key
        const msgKey = (() => { try { const k = hdr?.messageKey; return Number.isFinite(k) ? Number(k) : NaN; } catch(_) { return NaN; } })();

        // Convert to WE objects
        let weMsgId = null;
        let weFolderId = null;
        try { const weMsg = context.extension.messageManager.convert(hdr); weMsgId = weMsg?.id ?? null; } catch(_) {}
        try { const weFolder = context.extension.folderManager.convert(hdr?.folder); weFolderId = weFolder?.id ?? null; } catch(_) {}

        collector.push({ headerId: headerMessageId, headerMessageId, weMsgId, weFolderId, msgKey, subject, author, dateMs, folderUri });
      } catch (mapErr) {
        // continue
      }
    }

    return collector;
  } catch (e) {
    console.error("[glodaSearch] glodaQueryInternal failed", e);
    return [];
  }
}

var glodaSearch = class extends ExtensionCommonGloda.ExtensionAPI {
  getAPI(context) {
    return {
      glodaSearch: {
        async searchMessagesQuery(query, fromIso, toIso, limit = 200, ignoreDate = false) {
          try {
            return await searchMessagesQueryImpl(context, query, fromIso, toIso, limit, ignoreDate);
          } catch (e) {
            console.error("[glodaSearch] searchMessagesQuery failed", e);
            return [];
          }
        },
        async getConversationMessages(weMsgId, options = {}) {
          return await getConversationMessagesImpl(context, weMsgId, options);
        },
      },
    };
  }
};

this.glodaSearch = glodaSearch;



