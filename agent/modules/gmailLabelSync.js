/**
 * gmailLabelSync.js — Gmail REST API label sync.
 * Uses tmGmailLabels experiment for authenticated Gmail API calls
 * (OAuth2 + XPCOM HTTP from privileged parent process, bypassing CORS).
 *
 * Labels are created hidden (labelListVisibility: "labelHide") so they
 * don't clutter the Gmail web UI.
 */

import { ACTION_TAG_IDS } from "./tagDefs.js";

const _gmailAccountCache = new Map(); // accountId -> boolean
const _gmailTagLabelCache = new Map(); // accountId -> { tm_reply: "Label_123", ... }

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _isGmailAccount(accountId) {
  if (_gmailAccountCache.has(accountId)) return _gmailAccountCache.get(accountId);
  try {
    if (!browser.tmGmailLabels) return false;
    const token = await browser.tmGmailLabels.getAccessToken(accountId);
    const isGmail = !!token;
    _gmailAccountCache.set(accountId, isGmail);
    return isGmail;
  } catch (e) {
    _gmailAccountCache.set(accountId, false);
    return false;
  }
}

/**
 * Authenticated Gmail API call via the tmGmailLabels experiment.
 * The experiment handles OAuth2 tokens and fetch from parent process (bypasses CORS).
 * Returns parsed JSON or null.
 */
async function _gmailFetch(accountId, path, method = "GET", body = null) {
  const bodyJson = body ? JSON.stringify(body) : "";
  const responseStr = await browser.tmGmailLabels.gmailFetch(accountId, path, method, bodyJson);
  if (!responseStr) return null;
  return JSON.parse(responseStr);
}

/**
 * Ensure all tm_* Gmail labels exist (created hidden) and return a map of
 * tagId -> Gmail label ID.  Cached per account after first call.
 */
async function _ensureGmailTagLabels(accountId) {
  if (_gmailTagLabelCache.has(accountId)) return _gmailTagLabelCache.get(accountId);
  try {
    const data = await _gmailFetch(accountId, "/labels");
    const labels = data?.labels || [];
    const tagLabelMap = {}; // tagId -> Gmail label ID

    for (const tagId of Object.values(ACTION_TAG_IDS)) {
      const existing = labels.find(l => l.name === tagId);
      if (existing) {
        tagLabelMap[tagId] = existing.id;
        // Ensure label is hidden (may have been created visible by old folder approach)
        if (existing.labelListVisibility !== "labelHide" || existing.messageListVisibility !== "hide") {
          try {
            await _gmailFetch(accountId, `/labels/${existing.id}`, "PATCH", {
              labelListVisibility: "labelHide",
              messageListVisibility: "hide",
            });
            console.log(`[GMailTag] Hidden label: ${tagId}`);
          } catch (_) {}
        }
      } else {
        try {
          const created = await _gmailFetch(accountId, "/labels", "POST", {
            name: tagId,
            labelListVisibility: "labelHide",
            messageListVisibility: "hide",
          });
          if (created?.id) {
            tagLabelMap[tagId] = created.id;
            console.log(`[GMailTag] Created label: ${tagId} id=${created.id}`);
          } else {
            // 409 conflict — label exists but wasn't in initial list; re-fetch to find it
            console.log(`[GMailTag] Label ${tagId} create returned null (likely 409 conflict), re-fetching labels`);
            const refreshed = await _gmailFetch(accountId, "/labels");
            const match = (refreshed?.labels || []).find(l => l.name === tagId);
            if (match) {
              tagLabelMap[tagId] = match.id;
              console.log(`[GMailTag] Found label on retry: ${tagId} id=${match.id}`);
            }
          }
        } catch (eCreate) {
          console.log(`[GMailTag] FAILED to create label ${tagId}: ${eCreate}`);
        }
      }
    }

    _gmailTagLabelCache.set(accountId, tagLabelMap);
    return tagLabelMap;
  } catch (e) {
    console.log(`[GMailTag] _ensureGmailTagLabels ERROR: ${e}`);
    return null;
  }
}

/**
 * Resolve a headerMessageId to a Gmail message ID via search.
 * @returns {Promise<string|null>} Gmail message ID or null
 */
async function _resolveGmailMessageId(accountId, headerMessageId) {
  const result = await _gmailFetch(
    accountId,
    `/messages?q=${encodeURIComponent(`rfc822msgid:${headerMessageId}`)}&maxResults=1`
  );
  return result?.messages?.[0]?.id || null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Read action tag from Gmail label membership via REST API.
 * Returns the action name (e.g. "reply") or null if no tm_* label found.
 *
 * @param {string} accountId - Account ID
 * @param {string} headerMessageId - Message-ID header value (without angle brackets)
 * @returns {Promise<string|null>} Action name or null
 */
export async function readActionFromGmailFolders(accountId, headerMessageId) {
  try {
    if (!await _isGmailAccount(accountId)) return null;
    const tagLabels = await _ensureGmailTagLabels(accountId);
    if (!tagLabels || Object.keys(tagLabels).length === 0) return null;

    const gmailMsgId = await _resolveGmailMessageId(accountId, headerMessageId);
    if (!gmailMsgId) return null;

    const msg = await _gmailFetch(accountId, `/messages/${gmailMsgId}?format=minimal`);
    const labelIds = msg?.labelIds || [];

    // Reverse lookup: ACTION_TAG_IDS maps action → tagId (e.g. "reply" → "tm_reply")
    for (const [action, tagId] of Object.entries(ACTION_TAG_IDS)) {
      const labelId = tagLabels[tagId];
      if (labelId && labelIds.includes(labelId)) {
        console.log(`[GMailTag] readAction: found action="${action}" for headerMessageId=${headerMessageId}`);
        return action;
      }
    }
    return null;
  } catch (e) {
    console.log(`[GMailTag] readActionFromGmailFolders ERROR: ${e}`);
    return null;
  }
}

/**
 * For Gmail accounts, read the authoritative Gmail label and sync IMAP keyword
 * to match if they differ. Gmail labels are the source of truth for cross-instance
 * sync (iOS sets labels via REST API that don't appear as IMAP keywords).
 *
 * @param {object} header - Message header (.tags, .headerMessageId, .folder.accountId, .id)
 * @param {string|null} imapAction - Action already resolved from IMAP keywords
 * @returns {Promise<string|null>} Resolved action (Gmail overrides IMAP for Gmail accounts)
 */
export async function resolveGmailAction(header, imapAction) {
  try {
    const headerMsgId = (header.headerMessageId || "").replace(/[<>]/g, "");
    if (!headerMsgId || !header.folder?.accountId) return imapAction;

    const gmailAction = await readActionFromGmailFolders(header.folder.accountId, headerMsgId);
    if (!gmailAction) return imapAction;

    if (gmailAction !== imapAction) {
      // Gmail label is authoritative — sync IMAP keyword to match
      const targetTagId = ACTION_TAG_IDS[gmailAction];
      if (targetTagId) {
        const tmTagIds = new Set(Object.values(ACTION_TAG_IDS));
        const currentTags = Array.isArray(header.tags) ? header.tags : [];
        const nonTmTags = currentTags.filter(t => !tmTagIds.has(t));
        browser.messages.update(header.id, { tags: [targetTagId, ...nonTmTags] }).catch(e => {
          console.log(`[GMailTag] IMAP sync-on-read failed: ${e}`);
        });
        console.log(`[GMailTag] Synced IMAP keyword to match Gmail label: ${gmailAction} (was: ${imapAction || "none"})`);
      }
    }
    return gmailAction;
  } catch (e) {
    console.log(`[GMailTag] resolveGmailAction ERROR: ${e}`);
    return imapAction;
  }
}

/**
 * Sync a tag change via Gmail REST API (fire-and-forget).
 * Removes all tm_* labels, then adds the target label if specified.
 *
 * @param {number} msgId - WebExtension message ID
 * @param {string} accountId - Account ID
 * @param {string|null} targetTagId - e.g. "tm_reply", or null to clear all
 */
export async function syncGmailTagFolder(msgId, accountId, targetTagId) {
  try {
    if (!await _isGmailAccount(accountId)) return;

    const tagLabels = await _ensureGmailTagLabels(accountId);
    if (!tagLabels || Object.keys(tagLabels).length === 0) return;

    const header = await browser.messages.get(msgId);
    const headerMsgId = (header?.headerMessageId || "").replace(/[<>]/g, "");
    if (!headerMsgId) return;

    const gmailMsgId = await _resolveGmailMessageId(accountId, headerMsgId);
    if (!gmailMsgId) {
      console.log(`[GMailTag] syncGmailTagFolder: message not found in Gmail for headerMsgId=${headerMsgId}`);
      return;
    }

    const addLabelIds = targetTagId && tagLabels[targetTagId] ? [tagLabels[targetTagId]] : [];
    const removeLabelIds = Object.values(tagLabels).filter(id => !addLabelIds.includes(id));

    await _gmailFetch(accountId, `/messages/${gmailMsgId}/modify`, "POST", {
      addLabelIds,
      removeLabelIds,
    });

    if (targetTagId) {
      console.log(`[GMailTag] Set label ${targetTagId} on gmailMsgId=${gmailMsgId}`);
    } else {
      console.log(`[GMailTag] Cleared all tm_* labels on gmailMsgId=${gmailMsgId}`);
    }
  } catch (e) {
    console.log(`[GMailTag] syncGmailTagFolder FAILED: ${e}`);
  }
}
