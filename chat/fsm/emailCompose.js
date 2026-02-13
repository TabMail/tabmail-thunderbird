// emailCompose.js – new email composition workflow (compose_new_email, edit_recipient, email_edit, send_email)
// Thunderbird 140, MV3 compatible.
// NOTE: This module intentionally focuses on *logging* intermediate steps and
// exposing clear UI hooks rather than providing a full-fledged production-level
// implementation.  This keeps debugging straightforward and makes it easier to
// iterate on behaviour later.

import { trackComposeWindow } from "../../agent/modules/composeTracker.js";
import * as idb from "../../agent/modules/idbStorage.js";
import { getIdentityForMessage, log } from "../../agent/modules/utils.js";
import { ctx } from "../modules/context.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";
import { initialiseEmailCompose, streamText } from "../modules/helpers.js";
import { createNewAgentBubble } from "../chat.js";
import { awaitUserInput } from "../modules/converse.js";
import { isChatLinkMessage } from "../../chatlink/modules/core.js";
import { relayFsmConfirmation } from "../../chatlink/modules/fsm.js";
import { waitForComposeReady, setComposeBody, sendComposedEmail } from "../../chatlink/modules/compose.js";

// ---------------------------------------------------------------------------
// Shared validator/normalizer for recipients, cc, bcc lists used by tools
// ---------------------------------------------------------------------------
export async function validateAndNormalizeRecipientSets(
  input = {},
  options = {}
) {
  const prefix = options?.prefix || "[Compose/validate]";
  const requireRecipients = Boolean(options?.requireRecipients);

  function isProvided(arr) {
    return typeof arr !== "undefined";
  }
  function isArray(arr) {
    return Array.isArray(arr);
  }

  const rawRecipients = input?.recipients;
  const rawCc = input?.cc;
  const rawBcc = input?.bcc;

  const recipientsProvided = isProvided(rawRecipients);
  const ccProvided = isProvided(rawCc);
  const bccProvided = isProvided(rawBcc);

  // Validate recipients presence/shape
  if (requireRecipients) {
    if (!isArray(rawRecipients) || rawRecipients.length === 0) {
      return {
        ok: false,
        code: "missing_recipients",
        field: "recipients",
        message:
          "recipients parameter is required and must contain at least one recipient",
      };
    }
  } else if (recipientsProvided) {
    if (!isArray(rawRecipients) || rawRecipients.length === 0) {
      return {
        ok: false,
        code: "invalid_recipients_array",
        field: "recipients",
        message:
          "recipients parameter was provided but is invalid or empty array",
      };
    }
  }

  // Per-item validators
  function validateList(list, fieldName) {
    if (!isArray(list)) return null;
    for (let i = 0; i < list.length; i++) {
      const r = list[i];
      if (!r || typeof r !== "object" || !r.email) {
        return {
          ok: false,
          code: `${fieldName}_missing_email`,
          field: fieldName,
          index: i,
          message: `${fieldName} recipient at index ${i} is missing required email field`,
        };
      }
    }
    return null;
  }

  // Validate structure when provided
  const v1 = validateList(rawRecipients, "recipients");
  if (v1) return v1;
  const v2 = validateList(rawCc, "cc");
  if (v2) return v2;
  const v3 = validateList(rawBcc, "bcc");
  if (v3) return v3;

  // Normalize lists via contacts helper when provided
  async function normalize(list, label) {
    if (!isArray(list)) return [];
    try {
      const { normalizeRecipients } = await import("../modules/contacts.js");
      const before = list.map((r) => ({ ...r }));
      const normalized = await normalizeRecipients(list);
      try {
        console.log(
          `${prefix} Normalized ${label} from ${before.length} -> ${normalized.length}`
        );
      } catch (_) {}
      return normalized;
    } catch (e) {
      try {
        console.log(
          `${prefix} normalizeRecipients failed for ${label}: ${e}`,
          "warn"
        );
      } catch (_) {}
      return list;
    }
  }

  const recipients =
    recipientsProvided || requireRecipients
      ? await normalize(rawRecipients || [], "recipients")
      : [];
  const cc = ccProvided ? await normalize(rawCc || [], "cc") : [];
  const bcc = bccProvided ? await normalize(rawBcc || [], "bcc") : [];

  return { ok: true, recipients, cc, bcc };
}

// ---------------------------------------------------------------------------
// send_email – open compose window and wait until closed
// ---------------------------------------------------------------------------
export async function runStateSendEmail() {
  // Check for headless compose mode (ChatLink users bypass compose window)
  const useHeadless = CHAT_SETTINGS.headlessComposeEnabled || isChatLinkMessage();
  if (useHeadless) {
    log(`[Compose/send_email] Headless mode detected, redirecting to preview`);
    ctx.state = "send_email_preview";
    import("./core.js").then((m) => m.executeAgentAction());
    return;
  }

  // Bubble update hidden for this state.
  // const agentBubble = await createNewAgentBubble("Sending email…");

  try {
    // Determine whether the user prefers plain-text composition. We inspect the
    // default identity: composeHtml === false means plain-text.
    let isPlainTextPref = false;
    try {
      const accounts = await browser.accounts.list();
      const defaultIdentity = accounts?.[0]?.identities?.[0] || null;
      if (
        defaultIdentity &&
        Object.prototype.hasOwnProperty.call(defaultIdentity, "composeHtml")
      ) {
        isPlainTextPref = !defaultIdentity.composeHtml;
      }
      console.log(
        `[TMDBG Compose] defaultIdentity composeHtml=${defaultIdentity?.composeHtml} → isPlainTextPref=${isPlainTextPref}`
      );
    } catch (e) {
      console.warn("[Compose/send_email] Failed to read accounts:", e);
    }

    let tabId = null;
    if (ctx.composeDraft.replyToId) {
      // For replies from chat, update the reply cache before opening compose window
      // This prevents race condition with composeTracker.js and ensures consistent behavior
      try {
        const { getUniqueMessageKey } = await import(
          "../../agent/modules/utils.js"
        );
        const { STORAGE_PREFIX } = await import(
          "../../agent/modules/replyGenerator.js"
        );
        const { TS_PREFIX } = await import(
          "../../agent/modules/replyGenerator.js"
        );

        const uniqueMessageKey = await getUniqueMessageKey(
          ctx.composeDraft.replyToId
        );
        if (uniqueMessageKey && ctx.composeDraft.body) {
          const replyKey = STORAGE_PREFIX + uniqueMessageKey;
          const replyMetaKey = TS_PREFIX + uniqueMessageKey;
          await idb.set({
            [replyKey]: {
              reply: ctx.composeDraft.body,
              ts: Date.now(),
              source: "chat_compose",
              directReplace: true, // Enable direct replacement for replies from send_email
            },
          });
          // Ensure the TTL purge logic can see this entry.
          await idb.set({ [replyMetaKey]: { ts: Date.now() } });
          console.log(
            `[Compose/send_email] Updated reply cache with direct replacement for msgId ${ctx.composeDraft.replyToId} (key: ${uniqueMessageKey})`
          );
        }
      } catch (cacheErr) {
        console.log(
          `[Compose/send_email] Failed to update reply cache: ${cacheErr}`,
          "warn"
        );
      }

      // True reply flow – leverage Thunderbird threading headers.
      console.log(
        `[Compose/send_email] Using beginReply for msgId ${ctx.composeDraft.replyToId}`
      );
      const replyType = "replyToAll"; // Thunderbird 140 API expects "replyToAll" | "replyToSender" | "replyToList"

      // Resolve the correct identity for this reply based on the original message's account
      // Without this, Thunderbird defaults to the first identity which may be wrong for multi-account users
      const identityInfo = await getIdentityForMessage(ctx.composeDraft.replyToId);
      const replyDetails = { isPlainText: isPlainTextPref };
      if (identityInfo?.identityId) {
        replyDetails.identityId = identityInfo.identityId;
      }

      console.log(
        `[Compose/send_email] beginReply using replyType=${replyType} identityId=${identityInfo?.identityId || "(default)"} for msgId ${ctx.composeDraft.replyToId}`
      );
      const replyTab = await browser.compose.beginReply(
        ctx.composeDraft.replyToId,
        replyType,
        replyDetails
      );
      tabId =
        typeof replyTab === "object" && replyTab !== null && "id" in replyTab
          ? replyTab.id
          : replyTab;
      // Apply recipients/cc override after beginReply if provided
      try {
        const hasTo =
          Array.isArray(ctx.composeDraft.recipients) &&
          ctx.composeDraft.recipients.length > 0;
        const hasCc =
          Array.isArray(ctx.composeDraft.cc) && ctx.composeDraft.cc.length > 0;
        const hasBcc =
          Array.isArray(ctx.composeDraft.bcc) &&
          ctx.composeDraft.bcc.length > 0;
        if (hasTo || hasCc || hasBcc) {
          const toList = hasTo
            ? ctx.composeDraft.recipients.map((r) => `${r.name} <${r.email}>`)
            : undefined;
          const ccList = hasCc
            ? ctx.composeDraft.cc.map((r) => `${r.name} <${r.email}>`)
            : undefined;
          const bccList = hasBcc
            ? ctx.composeDraft.bcc.map((r) => `${r.name} <${r.email}>`)
            : undefined;
          const update = {};
          if (toList) update.to = toList;
          if (ccList) update.cc = ccList;
          if (bccList) update.bcc = bccList;
          await browser.compose.setComposeDetails(tabId, update);
          console.log(
            `[Compose/send_email] Applied overrides to reply compose tab ${tabId}: to=${
              toList?.length || 0
            } cc=${ccList?.length || 0} bcc=${bccList?.length || 0}`
          );
        } else {
          console.log(
            `[Compose/send_email] No recipients/cc/bcc override provided for reply compose tab ${tabId}`
          );
        }
      } catch (recErr) {
        console.log(
          `[Compose/send_email] Failed to set recipients on reply compose: ${recErr}`,
          "warn"
        );
      }
    } else if (ctx.composeDraft.forwardOfId) {
      console.log(
        `[Compose/send_email] Using beginForward for msgId ${ctx.composeDraft.forwardOfId}`
      );

      // Resolve the correct identity for this forward based on the original message's account
      const fwdIdentityInfo = await getIdentityForMessage(ctx.composeDraft.forwardOfId);
      const fwdDetails = { isPlainText: isPlainTextPref };
      if (fwdIdentityInfo?.identityId) {
        fwdDetails.identityId = fwdIdentityInfo.identityId;
      }

      const fwdTab = await browser.compose.beginForward(
        ctx.composeDraft.forwardOfId,
        fwdDetails
      );
      tabId =
        typeof fwdTab === "object" && fwdTab !== null && "id" in fwdTab
          ? fwdTab.id
          : fwdTab;
      // Apply recipients/cc (and subject, if present) after beginForward.
      try {
        const toList = Array.isArray(ctx.composeDraft.recipients)
          ? ctx.composeDraft.recipients.map((r) => `${r.name} <${r.email}>`)
          : [];
        const ccList = Array.isArray(ctx.composeDraft.cc)
          ? ctx.composeDraft.cc.map((r) => `${r.name} <${r.email}>`)
          : [];
        const bccList = Array.isArray(ctx.composeDraft.bcc)
          ? ctx.composeDraft.bcc.map((r) => `${r.name} <${r.email}>`)
          : [];
        const update = {};
        if (toList.length > 0) update.to = toList;
        if (ccList.length > 0) update.cc = ccList;
        if (bccList.length > 0) update.bcc = bccList;
        if (ctx.composeDraft.subject) update.subject = ctx.composeDraft.subject;
        if (Object.keys(update).length > 0) {
          await browser.compose.setComposeDetails(tabId, update);
          console.log(
            `[Compose/send_email] Applied recipients (${toList.length}) cc (${ccList.length}) bcc (${bccList.length}) and subject to forward compose tab ${tabId}`
          );
        } else {
          console.log(
            `[Compose/send_email] No recipients/cc/bcc/subject to apply on forward compose tab ${tabId}`
          );
        }
      } catch (recErr) {
        console.log(
          `[Compose/send_email] Failed to set recipients/subject on forward compose: ${recErr}`,
          "warn"
        );
      }
    } else {
      const details = {
        to: (ctx.composeDraft.recipients || []).map(
          (r) => `${r.name} <${r.email}>`
        ),
        cc: (ctx.composeDraft.cc || []).map((r) => `${r.name} <${r.email}>`),
        bcc: (ctx.composeDraft.bcc || []).map((r) => `${r.name} <${r.email}>`),
        subject: ctx.composeDraft.subject,
        // Omit body so Thunderbird can insert the signature automatically.
        isPlainText: isPlainTextPref,
      };
      const newTab = await browser.compose.beginNew(details);
      tabId =
        typeof newTab === "object" && newTab !== null && "id" in newTab
          ? newTab.id
          : newTab;
    }

    // Except for replies, store precompose draft for the compose content script to pick up.
    // Note: For replies, we updated the reply cache above instead to avoid race conditions with composeTracker.js
    if (!ctx.composeDraft.replyToId) {
      try {
        // Store both the content and the direct replacement flag
        const precomposeData = {
          content: ctx.composeDraft.body,
          directReplace: true, // Enable direct replacement when called from send_email
        };
        await idb.set({ ["activePrecompose:" + tabId]: precomposeData });
        console.log(
          `[Compose/send_email] Stored activePrecompose with direct replacement enabled for tab ${tabId}`
        );
      } catch (e) {
        console.log(
          `[Compose/send_email] Failed to store activePrecompose: ${e}`,
          "error"
        );
      }
    }
    // console.log(`[TMDBG Compose] beginNew returned`, newTab, "-> using id", tabId);

    // Track the compose window so that the background script knows it is open.
    trackComposeWindow(tabId);

    await new Promise((resolve) => {
      function handleRemoved(removedTabId) {
        // console.log(`[TMDBG Compose] onRemoved seen for`, removedTabId);
        if (removedTabId === tabId) {
          browser.tabs.onRemoved.removeListener(handleRemoved);
          resolve();
        }
      }
      browser.tabs.onRemoved.addListener(handleRemoved);
    });

    // Determine outcome using fast in-memory composeTracker flag
    let sendDetected = false;
    try {
      // In-memory fast path (consume and clear once read)
      try {
        const { consumeSendInitiated } = await import(
          "../../agent/modules/composeTracker.js"
        );
        sendDetected = consumeSendInitiated(tabId);
        try {
          console.log(
            `[Compose/send_email] consumeSendInitiated(${tabId}) -> ${sendDetected}`
          );
        } catch (_) {}
      } catch (_) {}
    } catch (_) {}

    if (!sendDetected) {
      try {
        if (ctx.activePid && ctx.fsmSessions[ctx.activePid]) {
          ctx.fsmSessions[ctx.activePid].failReason =
            "User closed compose window without sending, indicating user wants to cancel writing the email.";
        }
      } catch (_) {}
    }
  } catch (e) {
    console.log(
      `[Compose/send_email] Failed to open compose window: ${e}`,
      "error"
    );
  }

  // Reset compose draft & dedicated chat history for next time
  initialiseEmailCompose();

  // For FSM tools, go to exec_success by default, but exec_fail if no send was detected
  if (ctx.activePid) {
    const pid = ctx.activePid;
    const hasFail = Boolean(ctx.fsmSessions[pid]?.failReason);
    ctx.state = hasFail ? "exec_fail" : "exec_success";
    import("./core.js").then((m) => m.executeAgentAction());
  } else {
    // Non-FSM path should NEVER happen
    log(`[Compose/send_email] Non-FSM path should NEVER happen`, "error");
    ctx.state = "exec_fail";
    import("./core.js").then((m) => m.executeAgentAction());
  }
}

// ---------------------------------------------------------------------------
// send_email_preview – show email preview in chat for headless compose mode
// ---------------------------------------------------------------------------
export async function runStateSendEmailPreview() {
  const agentBubble = await createNewAgentBubble("Preparing email preview...");

  try {
    const draft = ctx.composeDraft || {};
    const pid = ctx.activePid || ctx.activeToolCallId || 0;

    // Build recipients display
    let toList = (draft.recipients || []).map((r) => r.name ? `${r.name} <${r.email}>` : r.email);
    let ccList = (draft.cc || []).map((r) => r.name ? `${r.name} <${r.email}>` : r.email);
    const bccList = (draft.bcc || []).map((r) => r.name ? `${r.name} <${r.email}>` : r.email);

    // For replies/forwards without explicit recipients, fetch from original message
    // Thunderbird's beginReply auto-determines recipients, but we need to show them in preview
    if (toList.length === 0 && (draft.replyToId || draft.forwardOfId)) {
      try {
        const msgId = draft.replyToId || draft.forwardOfId;
        const originalMsg = await browser.messages.get(msgId);
        if (originalMsg) {
          if (draft.replyToId) {
            // Reply: To = original sender (author)
            if (originalMsg.author) {
              toList = [originalMsg.author];
            }
            // Reply-all: Cc = original To + Cc (minus our own address)
            // Note: For simplicity, we show the original To recipients
            // The actual Thunderbird reply-all logic is more complex
            if (ccList.length === 0 && originalMsg.recipients && originalMsg.recipients.length > 0) {
              // Get our identity to filter it out from Cc
              const identityInfo = await getIdentityForMessage(msgId);
              const ourEmail = identityInfo?.email?.toLowerCase();
              const filteredRecipients = originalMsg.recipients.filter(r => {
                const email = r.toLowerCase();
                return !ourEmail || !email.includes(ourEmail);
              });
              if (filteredRecipients.length > 0) {
                ccList = filteredRecipients;
              }
            }
          } else if (draft.forwardOfId) {
            // Forward: No auto-recipients, user must specify
            // Leave toList empty - forward requires explicit recipients
          }
          log(`[Compose/preview] Fetched recipients from original message: To=${toList.length}, Cc=${ccList.length}`);
        }
      } catch (msgErr) {
        log(`[Compose/preview] Failed to fetch original message for recipients: ${msgErr}`, "warn");
      }
    }

    // Build preview text
    const previewLines = [];

    // Type indicator
    if (draft.replyToId) {
      previewLines.push("📧 **Reply**");
    } else if (draft.forwardOfId) {
      previewLines.push("📧 **Forward**");
    } else {
      previewLines.push("📧 **New Email**");
    }
    previewLines.push("");

    // From address (identity being used) - critical for multi-account users
    try {
      let fromAddress = null;
      if (draft.replyToId) {
        const identityInfo = await getIdentityForMessage(draft.replyToId);
        if (identityInfo?.email) {
          fromAddress = identityInfo.name
            ? `${identityInfo.name} <${identityInfo.email}>`
            : identityInfo.email;
        }
      } else if (draft.forwardOfId) {
        const identityInfo = await getIdentityForMessage(draft.forwardOfId);
        if (identityInfo?.email) {
          fromAddress = identityInfo.name
            ? `${identityInfo.name} <${identityInfo.email}>`
            : identityInfo.email;
        }
      } else {
        // New email - get default identity
        const accounts = await browser.accounts.list();
        const defaultIdentity = accounts?.[0]?.identities?.[0];
        if (defaultIdentity?.email) {
          fromAddress = defaultIdentity.name
            ? `${defaultIdentity.name} <${defaultIdentity.email}>`
            : defaultIdentity.email;
        }
      }
      if (fromAddress) {
        previewLines.push(`**From:** ${fromAddress}`);
      }
    } catch (fromErr) {
      log(`[Compose/preview] Failed to get From address for desktop: ${fromErr}`, "warn");
    }

    // Recipients
    if (toList.length > 0) {
      previewLines.push(`**To:** ${toList.join(", ")}`);
    }
    if (ccList.length > 0) {
      previewLines.push(`**Cc:** ${ccList.join(", ")}`);
    }
    if (bccList.length > 0) {
      previewLines.push(`**Bcc:** ${bccList.join(", ")}`);
    }

    // Subject
    if (draft.subject) {
      previewLines.push(`**Subject:** ${draft.subject}`);
    }

    previewLines.push("");

    // Body preview (truncate if too long for WhatsApp)
    const maxBodyLength = 1000;
    let bodyPreview = draft.body || "(no content)";
    if (bodyPreview.length > maxBodyLength) {
      bodyPreview = bodyPreview.substring(0, maxBodyLength) + "...";
    }
    previewLines.push(bodyPreview);

    const previewText = previewLines.join("\n");

    // Display preview in chat bubble
    agentBubble.classList.remove("loading");
    streamText(agentBubble, previewText);

    // Show confirmation prompt
    const confirmBubble = await createNewAgentBubble("Thinking...");
    confirmBubble.classList.remove("loading");
    const confirmText = "Would you like me to send this email?";
    streamText(confirmBubble, confirmText);

    // Relay to ChatLink (WhatsApp) with Send/Cancel buttons
    try {
      // For WhatsApp, format as plain text (no markdown) with comprehensive recipient info
      const plainPreviewLines = [];

      // Header with type
      if (draft.replyToId) {
        plainPreviewLines.push("📧 Reply");
      } else if (draft.forwardOfId) {
        plainPreviewLines.push("📧 Forward");
      } else {
        plainPreviewLines.push("📧 New Email");
      }
      plainPreviewLines.push("");

      // Get From address (identity being used) - critical for multi-account users
      try {
        let fromAddress = null;
        if (draft.replyToId) {
          const identityInfo = await getIdentityForMessage(draft.replyToId);
          if (identityInfo?.email) {
            fromAddress = identityInfo.name
              ? `${identityInfo.name} <${identityInfo.email}>`
              : identityInfo.email;
          }
        } else if (draft.forwardOfId) {
          const identityInfo = await getIdentityForMessage(draft.forwardOfId);
          if (identityInfo?.email) {
            fromAddress = identityInfo.name
              ? `${identityInfo.name} <${identityInfo.email}>`
              : identityInfo.email;
          }
        } else {
          // New email - get default identity
          const accounts = await browser.accounts.list();
          const defaultIdentity = accounts?.[0]?.identities?.[0];
          if (defaultIdentity?.email) {
            fromAddress = defaultIdentity.name
              ? `${defaultIdentity.name} <${defaultIdentity.email}>`
              : defaultIdentity.email;
          }
        }
        if (fromAddress) {
          plainPreviewLines.push(`From: ${fromAddress}`);
        }
      } catch (fromErr) {
        log(`[Compose/preview] Failed to get From address: ${fromErr}`, "warn");
      }

      // Recipients - show all fields including Bcc
      if (toList.length > 0) {
        plainPreviewLines.push(`To: ${toList.join(", ")}`);
      }
      if (ccList.length > 0) {
        plainPreviewLines.push(`Cc: ${ccList.join(", ")}`);
      }
      if (bccList.length > 0) {
        plainPreviewLines.push(`Bcc: ${bccList.join(", ")}`);
      }

      // Subject
      if (draft.subject) {
        plainPreviewLines.push(`Subject: ${draft.subject}`);
      }

      plainPreviewLines.push("");
      plainPreviewLines.push(bodyPreview);
      plainPreviewLines.push("");
      plainPreviewLines.push(confirmText);

      await relayFsmConfirmation(plainPreviewLines.join("\n"), "send");
    } catch (e) {
      log(`[Compose/preview] ChatLink relay failed (non-fatal): ${e}`, "warn");
    }

    // Set suggestion for desktop UI
    try {
      ctx.pendingSuggestion = "send";
      if (window.tmShowSuggestion) window.tmShowSuggestion();
    } catch (_) {}

    // Store pid for the headless send state
    if (pid && ctx.fsmSessions[pid]) {
      ctx.fsmSessions[pid].headlessComposeReady = true;
    }

    // Wait for user input
    awaitUserInput();

  } catch (e) {
    log(`[Compose/preview] Failed to build preview: ${e}`, "error");
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Failed to prepare email preview.");

    // Mark as failed
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].failReason = `Preview failed: ${e}`;
      }
    } catch (_) {}

    ctx.state = "exec_fail";
    import("./core.js").then((m) => m.executeAgentAction());
  }
}

// ---------------------------------------------------------------------------
// send_email_headless – programmatically create, set content, and send email
// ---------------------------------------------------------------------------
export async function runStateSendEmailHeadless() {
  const agentBubble = await createNewAgentBubble("Sending email...");

  try {
    const draft = ctx.composeDraft || {};
    const pid = ctx.activePid || ctx.activeToolCallId || 0;

    // Determine plain-text preference
    let isPlainTextPref = false;
    try {
      const accounts = await browser.accounts.list();
      const defaultIdentity = accounts?.[0]?.identities?.[0] || null;
      if (defaultIdentity && Object.prototype.hasOwnProperty.call(defaultIdentity, "composeHtml")) {
        isPlainTextPref = !defaultIdentity.composeHtml;
      }
    } catch (e) {
      log(`[Compose/headless] Failed to read accounts: ${e}`, "warn");
    }

    let tabId = null;

    // Open compose window based on type (reply/forward/new)
    if (draft.replyToId) {
      log(`[Compose/headless] Opening reply compose for msgId ${draft.replyToId}`);

      // Update reply cache for consistency
      try {
        const { getUniqueMessageKey } = await import("../../agent/modules/utils.js");
        const { STORAGE_PREFIX, TS_PREFIX } = await import("../../agent/modules/replyGenerator.js");

        const uniqueMessageKey = await getUniqueMessageKey(draft.replyToId);
        if (uniqueMessageKey && draft.body) {
          const replyKey = STORAGE_PREFIX + uniqueMessageKey;
          const replyMetaKey = TS_PREFIX + uniqueMessageKey;
          await idb.set({
            [replyKey]: {
              reply: draft.body,
              ts: Date.now(),
              source: "chat_headless",
              directReplace: true,
            },
          });
          await idb.set({ [replyMetaKey]: { ts: Date.now() } });
        }
      } catch (cacheErr) {
        log(`[Compose/headless] Failed to update reply cache: ${cacheErr}`, "warn");
      }

      const identityInfo = await getIdentityForMessage(draft.replyToId);
      const replyDetails = { isPlainText: isPlainTextPref };
      if (identityInfo?.identityId) {
        replyDetails.identityId = identityInfo.identityId;
      }

      const replyTab = await browser.compose.beginReply(draft.replyToId, "replyToAll", replyDetails);
      tabId = typeof replyTab === "object" && replyTab !== null && "id" in replyTab ? replyTab.id : replyTab;

    } else if (draft.forwardOfId) {
      log(`[Compose/headless] Opening forward compose for msgId ${draft.forwardOfId}`);

      const fwdIdentityInfo = await getIdentityForMessage(draft.forwardOfId);
      const fwdDetails = { isPlainText: isPlainTextPref };
      if (fwdIdentityInfo?.identityId) {
        fwdDetails.identityId = fwdIdentityInfo.identityId;
      }

      const fwdTab = await browser.compose.beginForward(draft.forwardOfId, fwdDetails);
      tabId = typeof fwdTab === "object" && fwdTab !== null && "id" in fwdTab ? fwdTab.id : fwdTab;

    } else {
      log(`[Compose/headless] Opening new compose`);

      const details = {
        to: (draft.recipients || []).map((r) => `${r.name} <${r.email}>`),
        cc: (draft.cc || []).map((r) => `${r.name} <${r.email}>`),
        bcc: (draft.bcc || []).map((r) => `${r.name} <${r.email}>`),
        subject: draft.subject,
        isPlainText: isPlainTextPref,
      };
      const newTab = await browser.compose.beginNew(details);
      tabId = typeof newTab === "object" && newTab !== null && "id" in newTab ? newTab.id : newTab;
    }

    if (!tabId) {
      throw new Error("Failed to open compose window");
    }

    log(`[Compose/headless] Compose window opened, tabId=${tabId}`);

    // Wait for compose to be ready (especially for replies/forwards with quotes)
    const isReplyOrForward = Boolean(draft.replyToId || draft.forwardOfId);
    const readyResult = await waitForComposeReady(tabId, {
      expectQuote: isReplyOrForward,
      maxWaitMs: 10000,
    });

    if (!readyResult.ok) {
      throw new Error(readyResult.error || "Compose window not ready");
    }

    log(`[Compose/headless] Compose ready, setting body`);

    // Set recipients if needed (for replies/forwards where recipients were specified)
    try {
      const hasTo = Array.isArray(draft.recipients) && draft.recipients.length > 0;
      const hasCc = Array.isArray(draft.cc) && draft.cc.length > 0;
      const hasBcc = Array.isArray(draft.bcc) && draft.bcc.length > 0;

      if (hasTo || hasCc || hasBcc || draft.subject) {
        const update = {};
        if (hasTo) update.to = draft.recipients.map((r) => `${r.name} <${r.email}>`);
        if (hasCc) update.cc = draft.cc.map((r) => `${r.name} <${r.email}>`);
        if (hasBcc) update.bcc = draft.bcc.map((r) => `${r.name} <${r.email}>`);
        if (draft.subject && !draft.replyToId) update.subject = draft.subject;

        if (Object.keys(update).length > 0) {
          await browser.compose.setComposeDetails(tabId, update);
          log(`[Compose/headless] Applied recipients/subject to compose`);
        }
      }
    } catch (recErr) {
      log(`[Compose/headless] Failed to set recipients: ${recErr}`, "warn");
    }

    // Set body content
    if (draft.body) {
      const bodyResult = await setComposeBody(tabId, draft.body, {
        isReplyOrForward,
      });
      if (!bodyResult.ok) {
        throw new Error(bodyResult.error || "Failed to set compose body");
      }
      log(`[Compose/headless] Body set successfully`);
    }

    // Send the email
    log(`[Compose/headless] Sending email...`);
    const sendResult = await sendComposedEmail(tabId, { mode: "sendNow" });

    if (!sendResult.ok) {
      throw new Error(sendResult.error || "Failed to send email");
    }

    log(`[Compose/headless] Email sent successfully, mode=${sendResult.mode}`);

    // Update bubble with success message
    agentBubble.classList.remove("loading");
    streamText(agentBubble, "Email sent successfully.");

    // Reset compose draft
    initialiseEmailCompose();

    // Move to success state
    ctx.state = "exec_success";
    import("./core.js").then((m) => m.executeAgentAction());

  } catch (e) {
    log(`[Compose/headless] Failed to send email: ${e}`, "error");

    agentBubble.classList.remove("loading");
    streamText(agentBubble, `Failed to send email: ${e.message || e}`);

    // Clean up compose window if it was opened
    // Note: sendComposedEmail should have closed it, but just in case
    try {
      // We don't have tabId in scope here after catch, so we can't close it
      // The compose window will need to be closed manually if send failed mid-way
    } catch (_) {}

    // Reset compose draft
    initialiseEmailCompose();

    // Mark as failed
    try {
      const pid = ctx.activePid || ctx.activeToolCallId || 0;
      if (pid && ctx.fsmSessions[pid]) {
        ctx.fsmSessions[pid].failReason = `Headless send failed: ${e}`;
      }
    } catch (_) {}

    ctx.state = "exec_fail";
    import("./core.js").then((m) => m.executeAgentAction());
  }
}
