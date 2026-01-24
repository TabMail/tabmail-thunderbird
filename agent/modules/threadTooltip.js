import { SETTINGS } from "./config.js";
import { resolveWeFolderFromXulUri } from "./folderResolver.js";
import { getSummaryWithHeaderId } from "./summaryGenerator.js";
import { log } from "./utils.js";

// Store listener references for cleanup
let _onHoverListener = null;

/**
 * Remove any existing tooltip listeners to prevent accumulation
 */
export function cleanupThreadTooltipHandlers() {
  if (_onHoverListener && browser.threadTooltip?.onHover) {
    try {
      browser.threadTooltip.onHover.removeListener(_onHoverListener);
      _onHoverListener = null;
      log("ThreadTooltip onHover listener cleaned up");
    } catch (e) {
      log(`Failed to remove ThreadTooltip onHover listener: ${e}`, "error");
    }
  }
}

export function attachThreadTooltipHandlers() {
  if (!SETTINGS.threadTooltipEnabled) {
    log("[ThreadTT] attachThreadTooltipHandlers called but disabled by config – skipping.");
    return;
  }
  // Clean up any existing listeners first
  cleanupThreadTooltipHandlers();
  
  // try {
  //   tooltipFetchListener = (message) => {
  //     if (!message || message.command !== "tooltipFetch") {
  //       return;
  //     }
  //     return (async () => {
  //       try {
  //         const msgId = Number(message.messageId);
  //         if (!msgId || Number.isNaN(msgId)) {
  //           return { error: "invalid-id" };
  //         }
  //         const header = await browser.messages.get(msgId);
  //         if (!header) {
  //           return { error: "not-found" };
  //         }
  //         // const cacheOnly = !!SETTINGS.threadTooltipCacheOnly;
  //         log(`[ThreadTT] tooltipFetch: calling getSummary(cacheOnly=${cacheOnly}) for msg ${msgId}`);
  //         const summaryRes = await getSummary(header, false, true);
  //         if (!summaryRes) {
  //           return { error: "summary-unavailable" };
  //         }
  //         return {
  //           blurb: summaryRes.blurb,
  //           todos: summaryRes.todos || "",
  //         };
  //       } catch (err) {
  //         return { error: "exception" };
  //       }
  //     })();
  //   };
    
  //   browser.runtime.onMessage.addListener(tooltipFetchListener);
  // } catch (e) {
  //   log(`threadTT: Failed to attach runtime.onMessage handler: ${e}`, "error");
  // }

  // // Ready ping from experiment window
  // try {
  //   tooltipReadyListener = (message) => {
  //     if (message && message.command === "threadTT-ready") {
  //       return { ok: true };
  //     }
  //   };
    
  //   browser.runtime.onMessage.addListener(tooltipReadyListener);
  // } catch (_) {}

  try {
    if (browser.threadTooltip && browser.threadTooltip.onHover && typeof browser.threadTooltip.onHover.addListener === 'function') {
      _onHoverListener = async (payload) => {
        const { headerId, folderUri } = payload || {};
        if (!headerId) return;
        // convert XUL folder URI to we folder object
        const weFolder = await resolveWeFolderFromXulUri(folderUri);
        try {
          // Use centralized getUniqueMessageKey for consistency
          const { getUniqueMessageKey } = await import("./utils.js");
          const fullHeaderId = await getUniqueMessageKey(headerId, weFolder);
          if (!fullHeaderId) {
            log(`[ThreadTT] onHover: failed to generate unique key for ${headerId}`, 'warn');
            return;
          }
          const summaryRes = await getSummaryWithHeaderId(fullHeaderId);
          if (!summaryRes) {
            log(`[ThreadTT] onHover: no summary found for ${fullHeaderId}`, 'warn');
            return;
          }
          const payloadOut = {
            blurb: summaryRes.blurb,
            todos: summaryRes.todos || '',
          };
          if (browser.threadTooltip?.display) {
            // log(`[ThreadTT] onHover: invoking display for ${headerId} (hasBlurb=${!!payloadOut.blurb}, hasTodos=${!!payloadOut.todos})`);
            browser.threadTooltip.display(headerId, payloadOut.blurb, payloadOut.todos);
          } else {
            log(`[ThreadTT] onHover: display API unavailable when trying to update tooltip for ${headerId}`, 'error');
          }
        } catch (e) {
          console.error('Agent: Error processing onHover', e);
        }
      };
      browser.threadTooltip.onHover.addListener(_onHoverListener);
    }
  } catch (e) {
    console.error('Agent: Error attaching onHover listener:', e);
  }
}

