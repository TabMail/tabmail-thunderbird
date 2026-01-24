// theme/modules/cardSnippetProvider.js
// MV3-side card snippet provider:
// - Tiered cache: memory → IDB (persistent) → native FTS → getFull
// - Bounded to near-viewport rows only (tmMessageList.getCardSnippetNeeds)
//
// TB 145 / MV3 note: do not use async runtime.onMessage handlers; this module doesn't register listeners.

import { getUniqueMessageKey, safeGetFull } from "../../agent/modules/utils.js";
import { extractPlainText } from "../../fts/bodyExtract.js";
import * as snippetCache from "./snippetCache.js";

// Lazy-loaded FTS search reference for direct API access (avoids runtime.sendMessage issues)
let _ftsSearchRef = null;
let _ftsSearchLoadAttempted = false;

/**
 * Get the FTS search API directly (for use in background script context).
 * Returns null if FTS is not available or not yet initialized.
 */
async function _getFtsSearch() {
  if (_ftsSearchRef) return _ftsSearchRef;
  if (_ftsSearchLoadAttempted) return null;
  _ftsSearchLoadAttempted = true;
  try {
    const { ftsSearch } = await import("../../fts/engine.js");
    if (ftsSearch) {
      _ftsSearchRef = ftsSearch;
      return ftsSearch;
    }
  } catch (e) {
    // FTS engine not available - this is expected if FTS is disabled or not initialized
    console.log(`[CardSnippetProvider] FTS engine import failed (expected if FTS disabled): ${e}`);
  }
  return null;
}

const CARD_SNIPPET_PROVIDER_CONFIG = {
  logPrefix: "[TabMail Theme][CardSnippetProvider]",
  // Max needs to process per tick (was maxNeedsPerPoll - renamed for event-driven architecture)
  maxNeedsPerTick: 24,
  // Use a larger cap so we can reliably fill 2 lines in Card View without cutting too early.
  maxSnippetChars: 320,
  maxSnippetLines: 2,
  // Allow more short lines to be included before flattening (prevents "early stop" on short emails).
  minSnippetNonEmptyLines: 1,
  maxSnippetNonEmptyLines: 6,
  diag: {
    maxLogs: 30,
    maxErrors: 30,
    maxNeedSamples: 6,
    minLogIntervalMs: 500,
    minSkipLogIntervalMs: 1000,
    maxEmptyLogs: 20,
  },
};

function _plog(...args) {
  try {
    console.log(CARD_SNIPPET_PROVIDER_CONFIG.logPrefix, ...args);
  } catch (_) {}
}

function _perr(...args) {
  try {
    console.error(CARD_SNIPPET_PROVIDER_CONFIG.logPrefix, ...args);
  } catch (_) {}
}

function _normalizeSnippet(text) {
  try {
    let t = String(text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    // Keep up to N non-empty-ish lines (configurable), then flatten.
    const lines = t
      .split("\n")
      .map((l) => String(l || "").trim())
      .filter(Boolean);
    const minLines = Number(CARD_SNIPPET_PROVIDER_CONFIG.minSnippetNonEmptyLines);
    const maxLines = Number(
      CARD_SNIPPET_PROVIDER_CONFIG.maxSnippetNonEmptyLines ??
      CARD_SNIPPET_PROVIDER_CONFIG.maxSnippetLines
    );
    const lineLimit = Number.isFinite(maxLines) && maxLines >= minLines ? maxLines : lines.length;
    t = lines.slice(0, lineLimit).join(" ");
    t = t.replace(/\s+/g, " ").trim();
    if (t.length > CARD_SNIPPET_PROVIDER_CONFIG.maxSnippetChars) {
      // Prefer cutting at a word boundary to avoid "… and" style awkward truncation.
      const limit = CARD_SNIPPET_PROVIDER_CONFIG.maxSnippetChars;
      const slice = t.slice(0, limit);
      const lastSpace = slice.lastIndexOf(" ");
      // Only use word-boundary cut if it doesn't shrink too much.
      const cut = lastSpace > Math.floor(limit * 0.7) ? slice.slice(0, lastSpace) : slice;
      t = cut.trim();
    }
    return t;
  } catch (_) {
    return "";
  }
}

// Cache pruning is now handled by snippetCache.js

async function _fetchSnippetViaFts(ftsKey) {
  try {
    if (!ftsKey) return "";
    // Use direct FTS API call instead of runtime.sendMessage
    // (runtime.sendMessage doesn't work within the same background script context)
    const ftsSearchApi = await _getFtsSearch();
    if (!ftsSearchApi) return "";
    const res = await ftsSearchApi.getMessageByMsgId(ftsKey);
    // Native FTS returns an object (or null) with `body`.
    const body = res?.body || res?.message?.body || "";
    return _normalizeSnippet(body);
  } catch (e) {
    _perr("FTS getMessageByMsgId failed", { msgId: String(ftsKey).slice(0, 80), error: String(e) });
    return "";
  }
}

async function _fetchSnippetViaGetFull(weId) {
  try {
    if (!weId) return "";
    // Use TabMail's bounded/cached wrapper to avoid hammering getFull on large folders.
    const full = await safeGetFull(weId);
    const text = await extractPlainText(full, weId);
    return _normalizeSnippet(text);
  } catch (e) {
    _perr("safeGetFull failed", { weId, error: String(e) });
    return "";
  }
}

export function createCardSnippetProvider({ getNeeds, provideSnippets }) {
  const state = {
    running: false,
    eventListener: null,
    logCount: 0,
    errCount: 0,
    lastLogMs: 0,
    lastSkipLogMs: 0,
    emptyLogCount: 0,
    lastEmptyLogMs: 0,
    missingKeyLogCount: 0,
    lastMissingKeyLogMs: 0,
  };

  async function tick() {
    if (!state.running) return;

    try {
      const needs = await getNeeds({ max: CARD_SNIPPET_PROVIDER_CONFIG.maxNeedsPerTick });
      
      // Always log what we got from getNeeds (bounded)
      if (state.logCount < CARD_SNIPPET_PROVIDER_CONFIG.diag.maxLogs) {
        _plog("[SnippetDiag] getNeedsReturned:", {
          count: Array.isArray(needs) ? needs.length : 0,
          sample: Array.isArray(needs) ? needs.slice(0, 3).map(n => ({
            hdrKey: n?.hdrKey?.slice(0, 40),
            weId: n?.weId,
            subject: n?.subject?.slice(0, 30),
          })) : [],
        });
      }
      
      if (!Array.isArray(needs) || needs.length === 0) return;

      const now = Date.now();
      const items = [];
      // MV3 memory cache removed - all cache hits now come from IDB
      let idbHit = 0;
      let cacheMiss = 0;
      let queued = 0;
      const sample = [];

      // Build a map of uniqueKey -> need info for batch lookups
      const needsByKey = new Map();
      for (const n of needs) {
        if (needsByKey.size >= CARD_SNIPPET_PROVIDER_CONFIG.maxNeedsPerTick) break;
        const hdrKey = String(n?.hdrKey || "");
        const msgId = String(n?.msgId || "");
        const weId = n?.weId ?? null;
        if (!hdrKey) continue;

        // Use the canonical unique key (accountId:folderPath:headerMessageId) for caching.
        let uniqueKey = "";
        try {
          if (weId != null) {
            uniqueKey = String(await getUniqueMessageKey(weId)) || "";
          }
        } catch (_) {}
        if (weId != null && !uniqueKey) {
          try {
            const nowMissing = Date.now();
            if (
              state.missingKeyLogCount < CARD_SNIPPET_PROVIDER_CONFIG.diag.maxLogs &&
              (nowMissing - state.lastMissingKeyLogMs) >= CARD_SNIPPET_PROVIDER_CONFIG.diag.minLogIntervalMs
            ) {
              state.missingKeyLogCount += 1;
              state.lastMissingKeyLogMs = nowMissing;
              _plog("[TMDBG SnippetDiag][BG] missing uniqueKey for weId", {
                weId,
                hdrKey,
                msgId: msgId.slice(0, 80),
              });
            }
          } catch (_) {}
        }
        const cacheKey = uniqueKey || hdrKey || msgId;
        const cacheKeyType = uniqueKey ? "uniqueKey" : (hdrKey ? "hdrKey" : "msgId");
        needsByKey.set(cacheKey, { hdrKey, msgId, weId, cacheKeyType });
      }

      // Batch lookup from IDB cache (MV3 memory cache removed - experiment has in-memory)
      const uniqueKeys = Array.from(needsByKey.keys());
      const cachedSnippets = await snippetCache.getSnippetsBatch(uniqueKeys);

      // Process each need
      for (const [cacheKey, needInfo] of needsByKey) {
        const { hdrKey, msgId, weId, cacheKeyType } = needInfo;

        // Check if we got a cached snippet (from IDB - MV3 memory cache removed)
        const cachedSnippet = cachedSnippets.get(cacheKey);
        if (cachedSnippet) {
          items.push({ hdrKey, snippet: cachedSnippet });
          idbHit += 1;
          continue;
        }

        cacheMiss += 1;

        // Queue fetch for cache misses
        queued += 1;
        if (sample.length < CARD_SNIPPET_PROVIDER_CONFIG.diag.maxNeedSamples) {
          sample.push({ hdrKey, msgId: msgId.slice(0, 80), weId, cacheKeyType });
        }

        // Fetch asynchronously (no concurrency limit - safeGetFull handles it)
        (async () => {
          try {
            let snippet = "";
            let source = "";
            let getFullSnippet = "";
            let ftsSnippet = "";

            // Prefer safeGetFull when we have weId
            if (weId) {
              getFullSnippet = await _fetchSnippetViaGetFull(weId);
              if (getFullSnippet) {
                snippet = getFullSnippet;
                source = "safeGetFull";
              }
            }
            // Fallback to native FTS by msgId
            if (!snippet) {
              const ftsKey = cacheKeyType === "uniqueKey" ? cacheKey : msgId;
              if (ftsKey) {
                ftsSnippet = await _fetchSnippetViaFts(ftsKey);
                if (ftsSnippet) {
                  snippet = ftsSnippet;
                  source = "nativeFts";
                }
              }
            }

            if (snippet) {
              // Store in persistent cache (memory + IDB) - only for non-empty snippets
              // Empty snippets are NEVER cached to avoid persisting race condition failures
              await snippetCache.setSnippet(cacheKey, snippet);

              try {
                await provideSnippets({ items: [{ hdrKey, snippet }], source: "mv3-provider" });
              } catch (eProvide) {
                state.errCount += 1;
                if (state.errCount <= CARD_SNIPPET_PROVIDER_CONFIG.diag.maxErrors) {
                  _perr("provideSnippets failed", { error: String(eProvide) });
                }
              }
            } else {
              // Empty snippet - do NOT cache, clear pending to allow immediate retry
              // This is important: if we don't clear pending, the experiment will block
              // retries for 12 seconds, causing many messages to show no snippets
              try {
                await provideSnippets({ items: [], clearPending: [hdrKey], source: "mv3-empty" });
              } catch (_) {}
              
              try {
                const nowEmpty = Date.now();
                if (
                  state.emptyLogCount < CARD_SNIPPET_PROVIDER_CONFIG.diag.maxEmptyLogs &&
                  (nowEmpty - state.lastEmptyLogMs) >= CARD_SNIPPET_PROVIDER_CONFIG.diag.minLogIntervalMs
                ) {
                  state.emptyLogCount += 1;
                  state.lastEmptyLogMs = nowEmpty;
                  _plog("[TMDBG SnippetDiag][BG] empty snippet (cleared pending, will retry)", {
                    hdrKey,
                    msgId: msgId.slice(0, 80),
                    weId,
                    cacheKeyType,
                    cacheKey: String(cacheKey).slice(0, 80),
                    source,
                    getFullLen: getFullSnippet.length,
                    ftsLen: ftsSnippet.length,
                  });
                }
              } catch (_) {}
            }
          } catch (e) {
            state.errCount += 1;
            if (state.errCount <= CARD_SNIPPET_PROVIDER_CONFIG.diag.maxErrors) {
              _perr("tick fetch failed", { error: String(e) });
            }
          }
        })();
      }

      // Provide cached snippets immediately (prevents flicker when rows recycle)
      if (items.length > 0) {
        try {
          await provideSnippets({ items, source: "mv3-cache" });
        } catch (eProvideCached) {
          state.errCount += 1;
          if (state.errCount <= CARD_SNIPPET_PROVIDER_CONFIG.diag.maxErrors) {
            _perr("provideSnippets (cache) failed", { error: String(eProvideCached) });
          }
        }
      }

      if (state.logCount < CARD_SNIPPET_PROVIDER_CONFIG.diag.maxLogs) {
        const elapsed = now - state.lastLogMs;
        if (elapsed >= CARD_SNIPPET_PROVIDER_CONFIG.diag.minLogIntervalMs) {
          state.lastLogMs = now;
          state.logCount += 1;
          const cacheStats = snippetCache.getStats();
          _plog("tick", {
            needs: needs.length,
            used: needsByKey.size,
            idbHit,
            cacheMiss,
            queued,
            cachedProvided: items.length,
            cacheStats,
            sample,
          });
        }
      }
    } catch (e) {
      state.errCount += 1;
      if (state.errCount <= CARD_SNIPPET_PROVIDER_CONFIG.diag.maxErrors) {
        _perr("tick failed", { error: String(e) });
      }
    }
  }

  function start() {
    if (state.running) return;
    state.running = true;
    
    // Event-driven mode - listen for onSnippetsNeeded event from experiment
    try {
      if (typeof browser !== "undefined" && browser.tmMessageListCardView?.onSnippetsNeeded?.addListener) {
        state.eventListener = (info) => {
          _plog("[SnippetDiag] eventReceived:", info);
          tick().catch((e) => {
            _perr("tick failed after event:", e);
          });
        };
        browser.tmMessageListCardView.onSnippetsNeeded.addListener(state.eventListener);
        _plog("[SnippetDiag] listenerRegistered");
        // Run an initial tick to handle any existing needs
        tick().catch(() => {});
        return;
      }
    } catch (e) {
      _perr("Failed to set up event listener:", e);
    }
    
    _plog("start (event not available - snippets will only work on provideCardSnippets calls)");
  }

  function stop() {
    if (!state.running) return;
    state.running = false;
    
    // Remove event listener
    if (state.eventListener) {
      try {
        if (typeof browser !== "undefined" && browser.tmMessageListCardView?.onSnippetsNeeded?.removeListener) {
          browser.tmMessageListCardView.onSnippetsNeeded.removeListener(state.eventListener);
        }
      } catch (_) {}
      state.eventListener = null;
    }
    
    _plog("stop");
  }

  return { start, stop, tick };
}

