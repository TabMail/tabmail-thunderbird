import { getPrivacyOptOutAllAiEnabled } from "../../chat/modules/privacySettings.js";
import { getAction } from "./actionGenerator.js";
import { SETTINGS } from "./config.js";
import { isInboxFolder } from "./folderUtils.js";
import { isInternalSender } from "./senderFilter.js";
import { getSummary } from "./summaryGenerator.js";
import { getAccessToken } from "./supabaseAuth.js";
import { applyActionTags } from "./tagHelper.js";
import { getUniqueMessageKey, log } from "./utils.js";

/**
 * Get the user's configured base font size from TB prefs
 * Checks both x-unicode (other writing systems) and x-western (latin)
 * since TB may use either for message display
 * Falls back to default if prefs are unavailable
 * @returns {Promise<number>} Font size in pixels
 */
async function getBaseFontSizePx() {
  // Fallback is 50 - if you see 50px fonts, wiring is broken!
  const defaultFontSize = SETTINGS.summaryBubble?.defaultBaseFontSizePx || 50;
  try {
    if (browser.tmPrefs && browser.tmPrefs.getInt) {
      // Try x-unicode first as TB often uses this for message body
      const unicodePref = await browser.tmPrefs.getInt("font.size.variable.x-unicode");
      if (unicodePref && unicodePref > 0) {
        log(`[TMDBG Banner] Read baseFontSizePx from x-unicode: ${unicodePref}`);
        return unicodePref;
      }
      // Fallback to x-western
      const westernPref = await browser.tmPrefs.getInt("font.size.variable.x-western");
      if (westernPref && westernPref > 0) {
        log(`[TMDBG Banner] Read baseFontSizePx from x-western: ${westernPref}`);
        return westernPref;
      }
    }
  } catch (e) {
    log(`[TMDBG Banner] Failed to read font size pref: ${e}`);
  }
  return defaultFontSize;
}

// Track pending "bubble ready" promises per tab, so agent can wait for content script to be ready.
const _pendingBubbleReady = new Map(); // Map<tabId, { resolve, timeout }>

function waitForBubbleReady(tabId, timeoutMs) {
  // If already resolved for this tab, return immediately
  if (_pendingBubbleReady.has(tabId)) {
    const entry = _pendingBubbleReady.get(tabId);
    if (entry.resolved) {
      return Promise.resolve();
    }
    // Already waiting, return same promise
    return entry.promise;
  }

  let resolveFunc;
  const promise = new Promise((resolve) => {
    resolveFunc = resolve;
  });

  const timeout = setTimeout(() => {
    const entry = _pendingBubbleReady.get(tabId);
    if (entry && !entry.resolved) {
      entry.resolved = true;
      entry.resolve();
      log(`[TMDBG Banner] Bubble ready timeout for tab ${tabId} (${timeoutMs}ms)`);
    }
  }, timeoutMs);

  _pendingBubbleReady.set(tabId, { promise, resolve: resolveFunc, timeout, resolved: false });
  return promise;
}

function signalBubbleReady(tabId) {
  const entry = _pendingBubbleReady.get(tabId);
  if (entry && !entry.resolved) {
    entry.resolved = true;
    clearTimeout(entry.timeout);
    entry.resolve();
    log(`[TMDBG Banner] Bubble ready signal received for tab ${tabId}`);
  }
}

function clearBubbleReadyState(tabId) {
  const entry = _pendingBubbleReady.get(tabId);
  if (entry) {
    clearTimeout(entry.timeout);
    _pendingBubbleReady.delete(tabId);
  }
}

// Export for use in background.js runtime message handler
export { clearBubbleReadyState, signalBubbleReady };

function getSummaryBannerSendRetryDelaysMs() {
  try {
    const arr = SETTINGS?.summaryBanner?.sendRetryDelaysMs;
    if (Array.isArray(arr) && arr.length > 0) {
      return arr
        .map((v) => (typeof v === "number" ? v : Number(v)))
        .filter((n) => Number.isFinite(n) && n >= 0);
    }
  } catch (_) {}
  return [];
}

function isReceivingEndDoesNotExistError(err) {
  try {
    const msg = String(err && err.message ? err.message : err || "");
    return (
      msg.includes("Receiving end does not exist") ||
      msg.includes("Could not establish connection") ||
      msg.includes("receiving end does not exist")
    );
  } catch (_) {
    return false;
  }
}

async function sendBannerMessageWithRetry(tabId, payload, contextLabel) {
  const delays = getSummaryBannerSendRetryDelaysMs();
  const t0 = Date.now();

  // For displaySummary messages, add the base font size from TB settings
  let enrichedPayload = payload;
  if (payload?.command === "displaySummary") {
    const baseFontSizePx = await getBaseFontSizePx();
    enrichedPayload = { ...payload, baseFontSizePx };
    log(`[TMDBG Banner] Enriched displaySummary with baseFontSizePx=${baseFontSizePx}`);
  }

  for (let i = 0; i < Math.max(1, delays.length); i++) {
    const delayMs = delays[i] ?? 0;
    if (delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }

    const attempt = i + 1;
    const attemptLabel = `${contextLabel || "banner"}#${attempt}/${Math.max(1, delays.length)}`;
    try {
      const tAttempt = Date.now();
      await browser.tabs.sendMessage(tabId, enrichedPayload);
      log(
        `[TMDBG Banner] sendMessage ok ${attemptLabel} dtAttempt=${Date.now() - tAttempt}ms dtTotal=${Date.now() - t0}ms cmd=${enrichedPayload?.command}`
      );
      return { ok: true, attempts: attempt, dtMs: Date.now() - t0 };
    } catch (e) {
      const dtTotal = Date.now() - t0;
      const shouldRetry = isReceivingEndDoesNotExistError(e) && i < delays.length - 1;
      log(
        `[TMDBG Banner] sendMessage failed ${attemptLabel} dtTotal=${dtTotal}ms cmd=${enrichedPayload?.command} err=${e} retry=${shouldRetry}`,
        shouldRetry ? "warn" : "error"
      );
      if (!shouldRetry) {
        return { ok: false, attempts: attempt, dtMs: dtTotal, error: String(e) };
      }
    }
  }

  return { ok: false, attempts: Math.max(1, delays.length), dtMs: Date.now() - t0, error: "exhausted" };
}

async function processVisibleMessages(tab, messages) {
  log(`Processing ${messages.length} visible messages for tab ${tab.id}.`);

  // Skip banner display if multiple messages are selected since there's no message preview pane
  const shouldShowBanner = messages.length === 1;
  let _bannerDisplayedFromCache = false;

  // If we are not going to show the summary banner UI, tell the display gate not to wait for it.
  // This prevents the preview from staying hidden in cases like multi-select.
  if (!shouldShowBanner) {
    try {
      // Gate control is handled by theme side; if this send fails due to listener timing,
      // it is non-fatal (gate is disabled in multi-select anyway).
      browser.tabs
        .sendMessage(tab.id, { command: "tm-gate-summary-disabled" })
        .catch((e) =>
          log(
            `[TMDBG Banner] Failed to send tm-gate-summary-disabled (multi-select) to tab ${tab.id}: ${e}`,
            "warn"
          )
        );
    } catch (e) {
      log(`[TMDBG Banner] tm-gate-summary-disabled (multi-select) threw: ${e}`, "warn");
    }
  }

  // Step 1: Wait for theme scripts to be ready, then tell the banner we're working (only for single message).
  // This provides instant feedback to the user.
  // Note: Banner injection is handled by theme/background.js
  if (shouldShowBanner) {
    // Wait for the summary bubble content script to signal it's ready to receive messages.
    // This avoids the "Receiving end does not exist" race condition.
    const bubbleReadyTimeoutMs = SETTINGS?.summaryBanner?.bubbleReadyTimeoutMs ?? 200;
    clearBubbleReadyState(tab.id); // Clear any stale state from previous message
    const tWaitStart = Date.now();
    await waitForBubbleReady(tab.id, bubbleReadyTimeoutMs);
    log(`[TMDBG Banner] Bubble ready wait done tab=${tab.id} dt=${Date.now() - tWaitStart}ms`);

    // Check signin status before proceeding with summary generation
    const accessToken = await getAccessToken();
    if (!accessToken) {
      log(`[TMDBG Banner] User not logged in, showing signin prompt in bubble for tab ${tab.id}`);
      const notLoggedInMessage = SETTINGS?.summaryBanner?.notLoggedInMessage || "Not logged in, please signin from the toolbar menu on the top-right";
      await sendBannerMessageWithRetry(
        tab.id,
        { command: "displaySummary", blurb: notLoggedInMessage, todos: "", isWarning: true },
        "notLoggedIn:displaySummary"
      );
      return; // Skip further processing when not logged in
    }

    // Cache-first UX: if summary is already cached, skip the "Analyzing…" flash and show immediately.
    try {
      const tCacheStart = Date.now();
      const firstMessage = messages[0];
      const cached = await getSummary(firstMessage, false, true); // cache only
      log(`[TMDBG Banner] cacheOnly getSummary done tab=${tab.id} dt=${Date.now() - tCacheStart}ms`);
      const hasCachedContent =
        !!cached &&
        (Boolean(cached.blurb && String(cached.blurb).trim()) ||
          Boolean(cached.todos && String(cached.todos).trim()) ||
          Boolean(cached.detailed && String(cached.detailed).trim()));

      if (hasCachedContent) {
        log(
          `[TMDBG Banner] Cache-first: sending displaySummary immediately for tab ${tab.id} (skipping summaryProcessing)`
        );
        _bannerDisplayedFromCache = true;
      await sendBannerMessageWithRetry(
        tab.id,
        {
          command: "displaySummary",
          blurb: cached.blurb || "",
          todos: cached.todos || "",
        },
        "cacheFirst:displaySummary"
      );
      } else {
        // Cache MISS: send displaySummary with empty content to show "Analyzing..." and signal ready.
        // The gate will reveal immediately, then we fire-and-forget the LLM call which updates later.
        log(`[TMDBG Banner] Cache MISS: sending displaySummary with empty content for tab ${tab.id}`);
        await sendBannerMessageWithRetry(
          tab.id,
          { command: "displaySummary", blurb: "", todos: "" },
          "cacheFirst:displaySummary:analyzing"
        );
      }
    } catch (e) {
      log(`[TMDBG Banner] Cache-first check failed; sending empty displaySummary: ${e}`, "warn");
      await sendBannerMessageWithRetry(
        tab.id,
        { command: "displaySummary", blurb: "", todos: "" },
        "cacheFirst:displaySummary:catch"
      );
    }
  }

  try {
    // Determine internal/self-sent messages (we still want summaries for them, but we do NOT want to apply action tags).
    const internalById = new Map(); // Map<number, boolean>
    try {
      for (const msg of messages) {
        try {
          const internal = await isInternalSender(msg);
          internalById.set(msg.id, internal);
          try {
            if (SETTINGS?.actionTagging?.debugTagRace?.enabled === true) {
              log(
                `[TMDBG TagRace] summary internalCheck id=${msg?.id} internal=${internal} author="${msg?.author || ""}" subject="${msg?.subject || ""}"`
              );
            }
          } catch (_) {}
        } catch (_) {
          internalById.set(msg.id, false);
        }
      }
    } catch (_) {}

    // No tag/action-cache cleanup for internal/self-sent messages.
    // Invariant is enforced at the source: we do not store action cache for internal messages.

    // Step 2: Fetch all summaries in parallel.
    const summaryPromises = messages.map((msg) => getSummary(msg));
    const summaries = (await Promise.all(summaryPromises)).filter(
      (s) => s !== null
    );

    if (summaries.length === 0) {
      log("No summaries could be fetched for the visible messages.");
      // Note: summaryError is not handled by banner script, so this will fail silently
      browser.tabs
        .sendMessage(tab.id, {
          command: "summaryError",
          message: "Could not retrieve email summary.",
        })
        .catch(() => {
          // Expected to fail - banner doesn't handle summaryError
        });
      return;
    }

    log(`Fetched ${summaries.length} summaries. Now fetching batch actions.`);

    // Step 3: Fetch actions for the summaries we successfully retrieved.
    // Build payload for the batch actions endpoint and log it for debugging.
    const actions = {};
    const externalMessages = messages.filter((m) => !internalById.get(m.id));
    if (externalMessages.length === 0) {
      log(`[TMDBG Actions] Skipping action generation/tagging: all visible messages are internal/self-sent`);
    } else {
      await Promise.all(
        externalMessages.map(async (msg) => {
          const action = await getAction(msg);
          if (action) actions[await getUniqueMessageKey(msg.id)] = action;
        })
      );
    }
    log(`[TMDBG Actions] Local actions computed: ${JSON.stringify(actions)}`);

    // Step 4: Display the summary and action for the primary message in the banner (only for single message).
    if (shouldShowBanner) {
      const firstMessage = messages[0];
      const firstMessageKey = await getUniqueMessageKey(firstMessage.id);
      const summaryForBanner = summaries.find((s) => s.id === firstMessageKey);

      if (summaryForBanner) {
        if (_bannerDisplayedFromCache) {
          log(`[TMDBG Banner] Cache-first banner already displayed; sending displaySummary again for consistency`);
        }
        // log(`Sending displaySummary to banner for message ${firstMessage.id}`);
        await sendBannerMessageWithRetry(
          tab.id,
          {
            command: "displaySummary",
            blurb: summaryForBanner.blurb,
            todos: summaryForBanner.todos || "",
          },
          "final:displaySummary"
        );
      } else {
        log(`Could not find summary for the first message to display in banner.`);
        // Note: summaryError is not handled by banner script, so this will fail silently
        browser.tabs
          .sendMessage(tab.id, {
            command: "summaryError",
            message: "Could not determine summary.",
          })
          .catch(() => {
            // Expected to fail - banner doesn't handle summaryError
          });
      }
    }

    // Only apply action tags to external messages. For internal/self-sent, we intentionally apply NO action tag
    // (not even tm_none) so "no tag applied" is preserved.
    if (externalMessages.length > 0) {
      await applyActionTags(externalMessages, actions);
    }

    // Step 5: Run unified pipeline (cached). Dynamic import avoids static cycle.
    // Note that this will only generate reply as other steps are cached.
    try {
      const { enqueueProcessMessage } = await import("./messageProcessorQueue.js");
      const firstExternal = externalMessages[0] || null;
      if (firstExternal) {
        // Queue for persistent processing so offline/disruptions are retried.
        await enqueueProcessMessage(firstExternal, { isPriority: false, source: "summary:postAction" });
      } else {
        // No external messages selected; summaries already handled above.
      }
    } catch (e) {
      log(`[TMDBG Summary] Failed to run processMessage post-action: ${e}`);
    }
  } catch (e) {
    log(`FATAL: Error in processVisibleMessages: ${e}`, "error");
    // Let the user know something went wrong (only for single message with banner).
    if (shouldShowBanner) {
      // Note: summaryError is not handled by banner script, so this will fail silently
      browser.tabs
        .sendMessage(tab.id, {
          command: "summaryError",
          message: "An unexpected error occurred.",
        })
        .catch(() => {
          // Expected to fail - banner doesn't handle summaryError
        });
    }
  }
}

async function onMessagesDisplayed(tab, messageList) {
  log(`[Summary] onMessagesDisplayed fired for tab ${tab.id}`);

  // Privacy opt-out: do not attempt to show/inject summary banner UI or run summary pipeline.
  try {
    const optOut = await getPrivacyOptOutAllAiEnabled();
    if (optOut) {
      log(
        `[Summary] Privacy opt-out enabled; skipping summary pipeline and banner messaging for tab ${tab.id}`,
        "warn"
      );
      // Also tell the display gate not to wait for summary UI, otherwise preview may remain hidden.
      try {
        browser.tabs
          .sendMessage(tab.id, { command: "tm-gate-summary-disabled" })
          .catch((e) =>
            log(`[Summary] Failed to send tm-gate-summary-disabled (privacy opt-out) to tab ${tab.id}: ${e}`, "warn")
          );
      } catch (e) {
        log(`[Summary] tm-gate-summary-disabled (privacy opt-out) threw: ${e}`, "warn");
      }
      return;
    }
  } catch (e) {
    log(`[Summary] Privacy opt-out check failed in onMessagesDisplayed: ${e}`, "warn");
  }
  
  let messageArray;

  // The API provides a MessageList object which has a `messages` property containing the array.
  if (messageList && Array.isArray(messageList.messages)) {
    messageArray = messageList.messages;
    log(`[Summary] Found ${messageArray.length} messages in messageList`);
  } else {
    let details = "Not available";
    if (messageList) {
      try {
        details = `Keys: [${Object.keys(messageList).join(", ")}]`;
      } catch (e) {
        details = "Could not get keys.";
      }
    }
    log(
      `[Summary] onMessagesDisplayed fired but messageList.messages was not an array. Type: ${typeof messageList}. Details: ${details}`,
      "error"
    );
    return;
  }

  if (messageArray.length === 0) {
    log(`[Summary] No messages to process in tab ${tab.id}`);
    return; // Nothing to do.
  }

  // Check if messages are in the inbox folder - skip processing for archive, trash, etc.
  // This prevents wasteful API calls during email organization work
  const firstMessage = messageArray[0];
  const folder = firstMessage?.folder;
  const inInbox = isInboxFolder(folder);
  
  log(`[Summary] Folder check: name="${folder?.name}", type="${folder?.type}", path="${folder?.path}", isInbox=${inInbox}`);
  
  if (!inInbox) {
    log(`[Summary] Skipping processing - message not in inbox (folder: "${folder?.name}", type: "${folder?.type}")`);
    // We intentionally do not run summary/quote abstractions outside Inbox.
    // Tell the display gate not to wait for summary UI so the message preview remains visible.
    try {
      browser.tabs
        .sendMessage(tab.id, { command: "tm-gate-summary-disabled" })
        .catch((e) =>
          log(`[Summary] Failed to send tm-gate-summary-disabled (non-inbox) to tab ${tab.id}: ${e}`, "warn")
        );
    } catch (e) {
      log(`[Summary] tm-gate-summary-disabled (non-inbox) threw: ${e}`, "warn");
    }
    return;
  }

  // NOTE: We do NOT filter internal/self-sent messages here anymore.
  // We still want summaries/bubble for them, but we will skip action tag application later
  // inside processVisibleMessages().

  // Log details of each message for debugging
  messageArray.forEach((msg, idx) => {
    log(`[Summary] Message ${idx + 1}: id=${msg.id}, subject="${msg.subject}", author="${msg.author}"`);
  });

  log(`[Summary] Processing ${messageArray.length} visible messages in tab ${tab.id}`);

  // The new, unified logic for processing all visible messages.
  await processVisibleMessages(tab, messageArray);
  
  log(`[Summary] Completed processing visible messages in tab ${tab.id}`);
}

export function initSummaryFeatures() {
  browser.messageDisplay.onMessagesDisplayed.addListener(onMessagesDisplayed);
  log("Summary features initialized.");
  // Banner registration is now handled in theme/background.js
}

/**
 * Refreshes the summary bubble for the currently displayed message.
 * Called after signin to update the bubble from "not logged in" warning to actual summary.
 */
export async function refreshCurrentMessageSummary() {
  try {
    log("[Summary] refreshCurrentMessageSummary called - refreshing after signin");
    
    // Get the active mail tab
    const [activeMailTab] = await browser.mailTabs.query({ active: true });
    if (!activeMailTab) {
      log("[Summary] No active mail tab found for refresh");
      return;
    }
    
    // Get the tab ID (TB 145 MailTab uses tabId or id)
    const tabId = activeMailTab.tabId ?? activeMailTab.id;
    if (!tabId) {
      log("[Summary] Could not get tab ID from active mail tab");
      return;
    }
    
    // Get the tab object for passing to processVisibleMessages
    const tab = await browser.tabs.get(tabId);
    if (!tab) {
      log("[Summary] Could not get tab object for refresh");
      return;
    }
    
    // Get the selected messages
    const selection = await browser.mailTabs.getSelectedMessages(tabId);
    if (!selection || !selection.messages || selection.messages.length === 0) {
      log("[Summary] No messages selected in active mail tab");
      return;
    }
    
    log(`[Summary] Refreshing summary for ${selection.messages.length} message(s) in tab ${tabId}`);
    
    // Re-run the summary pipeline for the current message(s)
    await processVisibleMessages(tab, selection.messages);
    
    log("[Summary] Summary refresh complete");
  } catch (e) {
    log(`[Summary] refreshCurrentMessageSummary failed: ${e}`, "error");
  }
}
