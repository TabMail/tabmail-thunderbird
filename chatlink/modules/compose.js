/**
 * ChatLink Compose Helpers
 *
 * Programmatic email sending and compose preview for ChatLink integration.
 * Uses standard MV3 browser.compose API.
 *
 * Thunderbird 145 MV3 WebExtension
 */

import { log } from "../../agent/modules/utils.js";

/**
 * Extract plain text from HTML content for preview relay.
 */
function htmlToPlainText(html) {
  if (!html) return "";
  try {
    return html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, "")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch (e) {
    return String(html);
  }
}

/**
 * Wait for compose window to be ready.
 * For replies/forwards, waits until the quote/forward content is loaded.
 *
 * @param {number} tabId - The compose window tab ID
 * @param {object} options - Options
 * @param {boolean} options.expectQuote - True for replies/forwards that should have quote content
 * @param {number} options.maxWaitMs - Maximum wait time (default 8000ms)
 * @returns {Promise<{ok: boolean, details?: object, error?: string}>}
 */
export async function waitForComposeReady(tabId, options = {}) {
  const { expectQuote = false, maxWaitMs = 8000 } = options;
  const pollInterval = 200;
  let waited = 0;

  log(`[ChatLink Compose] waitForComposeReady tabId=${tabId} expectQuote=${expectQuote}`);

  while (waited < maxWaitMs) {
    try {
      const details = await browser.compose.getComposeDetails(tabId);

      if (!details) {
        await new Promise(r => setTimeout(r, pollInterval));
        waited += pollInterval;
        continue;
      }

      // For replies/forwards, wait until body has content (quote loaded)
      if (expectQuote) {
        const body = details.plainTextBody || details.body || "";
        if (body.trim().length > 0) {
          log(`[ChatLink Compose] Compose ready with quote after ${waited}ms`);
          return { ok: true, details };
        }
      } else {
        // For new emails, compose is ready immediately
        log(`[ChatLink Compose] Compose ready (new email) after ${waited}ms`);
        return { ok: true, details };
      }
    } catch (e) {
      log(`[ChatLink Compose] getComposeDetails error: ${e}`, "warn");
    }

    await new Promise(r => setTimeout(r, pollInterval));
    waited += pollInterval;
  }

  log(`[ChatLink Compose] waitForComposeReady timed out after ${maxWaitMs}ms`, "warn");
  return { ok: false, error: "Compose window not ready (timeout)" };
}

/**
 * Set the plaintext body of a compose window.
 * For replies/forwards, prepends the new content to the existing quote.
 * For new emails, sets the body directly.
 *
 * @param {number} tabId - The compose window tab ID
 * @param {string} newContent - The new content to add (reply text, forward message, or full body)
 * @param {object} options - Options
 * @param {boolean} options.isReplyOrForward - True to prepend to existing quote content
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function setComposeBody(tabId, newContent, options = {}) {
  const { isReplyOrForward = false } = options;

  try {
    log(`[ChatLink Compose] setComposeBody tabId=${tabId} contentLen=${newContent?.length || 0} isReplyOrForward=${isReplyOrForward}`);

    if (isReplyOrForward) {
      // Get existing content (quote) first
      const details = await browser.compose.getComposeDetails(tabId);
      const existingBody = details?.plainTextBody || details?.body || "";

      // Prepend new content with separator
      const separator = "\n\n";
      const fullBody = (newContent || "") + separator + existingBody;

      await browser.compose.setComposeDetails(tabId, {
        plainTextBody: fullBody,
      });
    } else {
      // New email - set body directly
      await browser.compose.setComposeDetails(tabId, {
        plainTextBody: newContent || "",
      });
    }

    return { ok: true };
  } catch (e) {
    log(`[ChatLink Compose] setComposeBody failed: ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

/**
 * Send an email from an open compose window programmatically.
 * Uses standard browser.compose.sendMessage API.
 *
 * IMPORTANT: Ensure the compose body is set before calling this.
 * For ChatLink flow, call setComposeBody() first to bypass the autocomplete system.
 *
 * @param {number} tabId - The compose window tab ID
 * @param {object} options - Send options
 * @param {string} options.mode - 'default', 'sendNow', or 'sendLater'
 * @returns {Promise<{ok: boolean, mode?: string, headerMessageId?: string, messages?: Array, error?: string}>}
 */
export async function sendComposedEmail(tabId, options = {}) {
  try {
    const mode = options?.mode || "default";
    log(`[ChatLink Compose] sendComposedEmail tabId=${tabId} mode=${mode}`);

    // Prepare send options
    const sendOptions = {};
    if (mode === "sendNow" || mode === "sendLater" || mode === "default") {
      sendOptions.mode = mode;
    }

    // Use standard MV3 compose.sendMessage API
    const result = await browser.compose.sendMessage(tabId, sendOptions);

    log(`[ChatLink Compose] sendMessage result: mode=${result?.mode} headerMessageId=${result?.headerMessageId || "(none)"}`);

    return {
      ok: true,
      mode: result?.mode || mode,
      headerMessageId: result?.headerMessageId,
      messages: result?.messages,
    };
  } catch (e) {
    log(`[ChatLink Compose] sendComposedEmail failed: ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

/**
 * Close a compose window without sending.
 * Discards the draft.
 *
 * @param {number} tabId - The compose window tab ID
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function closeComposeWindow(tabId) {
  try {
    log(`[ChatLink Compose] closeComposeWindow tabId=${tabId}`);

    // Simply close/remove the tab - this discards the compose without sending
    await browser.tabs.remove(tabId);

    return { ok: true };
  } catch (e) {
    log(`[ChatLink Compose] closeComposeWindow failed: ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

/**
 * Get a preview of the composed email for relay to WhatsApp.
 *
 * @param {number} tabId - The compose window tab ID
 * @returns {Promise<{ok: boolean, to?: string[], cc?: string[], subject?: string, body?: string, ...}>}
 */
export async function getComposePreview(tabId) {
  try {
    log(`[ChatLink Compose] getComposePreview tabId=${tabId}`);

    // Use standard MV3 compose.getComposeDetails API
    const details = await browser.compose.getComposeDetails(tabId);

    if (!details) {
      return { ok: false, error: "Could not get compose details" };
    }

    // Get attachment count
    let attachmentCount = 0;
    try {
      const attachments = await browser.compose.listAttachments(tabId);
      attachmentCount = attachments?.length || 0;
    } catch (_) {}

    // Extract body as plain text
    let bodyText = "";
    if (details.isPlainText && details.plainTextBody) {
      bodyText = details.plainTextBody;
    } else if (details.body) {
      bodyText = htmlToPlainText(details.body);
    }

    // Determine if this is a reply or forward
    const isReply = details.type === "reply" || details.type === "replyToAll" || details.type === "replyToList";
    const isForward = details.type === "forward";

    return {
      ok: true,
      to: details.to || [],
      cc: details.cc || [],
      bcc: details.bcc || [],
      subject: details.subject || "",
      body: bodyText,
      isReply,
      isForward,
      attachmentCount,
    };
  } catch (e) {
    log(`[ChatLink Compose] getComposePreview failed: ${e}`, "error");
    return { ok: false, error: String(e) };
  }
}

/**
 * Build a plain text preview of an email for WhatsApp relay.
 * Formats the email details in a readable way for chat display.
 *
 * @param {object} preview - Result from getComposePreview
 * @returns {string} - Formatted preview text
 */
export function buildEmailPreviewText(preview) {
  if (!preview?.ok) {
    return "Could not preview email.";
  }

  const lines = [];

  // Recipients
  if (preview.to?.length > 0) {
    lines.push(`To: ${preview.to.join(", ")}`);
  }
  if (preview.cc?.length > 0) {
    lines.push(`Cc: ${preview.cc.join(", ")}`);
  }
  if (preview.bcc?.length > 0) {
    lines.push(`Bcc: ${preview.bcc.join(", ")}`);
  }

  // Subject
  if (preview.subject) {
    lines.push(`Subject: ${preview.subject}`);
  }

  // Attachments
  if (preview.attachmentCount > 0) {
    lines.push(`Attachments: ${preview.attachmentCount}`);
  }

  // Type indicator
  if (preview.isReply) {
    lines.push(`(Reply)`);
  } else if (preview.isForward) {
    lines.push(`(Forward)`);
  }

  lines.push(""); // Empty line before body

  // Body preview (truncate if too long)
  const maxBodyLength = 500;
  let body = preview.body || "(no content)";
  if (body.length > maxBodyLength) {
    body = body.substring(0, maxBodyLength) + "...";
  }
  lines.push(body);

  return lines.join("\n");
}
