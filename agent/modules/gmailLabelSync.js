/**
 * gmailLabelSync.js — Gmail REST API label REMOVE-only sync.
 *
 * Post Phase 0 scope: this module exists solely to REMOVE `tm_*` Gmail labels
 * from a message when it leaves inbox (passive decay per PLAN_TB_LABEL_V2 §Phase 4).
 *
 * What's gone:
 *   - No Gmail label CREATE (we never add `tm_*` anymore).
 *   - No readActionFromGmailFolders / resolveGmailAction (first-compute-wins
 *     removed from actionGenerator.js — Device Sync probe is the cross-instance path).
 *   - No syncGmailTagFolder ADD branch.
 *
 * What remains:
 *   - Lookup of EXISTING `tm_*` Gmail label IDs (no create, only list + match).
 *   - `removeTmLabelsFromGmailMessage(msgId, accountId, headerMessageId)` —
 *     removes all `tm_*` labels from a Gmail message. Called by onMoved's
 *     leave-inbox cleanup.
 *
 * Uses the tmGmailLabels experiment for OAuth2 + CORS-bypassing fetch.
 */

import { ACTION_TAG_IDS } from "./tagDefs.js";

const _gmailAccountCache = new Map(); // accountId -> boolean
const _gmailTagLabelCache = new Map(); // accountId -> { tm_reply: "Label_123", ... } (EXISTING labels only)

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

async function _gmailFetch(accountId, path, method = "GET", body = null) {
  const bodyJson = body ? JSON.stringify(body) : "";
  const responseStr = await browser.tmGmailLabels.gmailFetch(accountId, path, method, bodyJson);
  if (!responseStr) return null;
  return JSON.parse(responseStr);
}

/**
 * Look up EXISTING `tm_*` Gmail label IDs for this account. Does NOT create
 * any missing labels — we're in REMOVE-only mode. Returns a map of
 * tagId -> Gmail label ID (only entries for labels that actually exist).
 */
async function _lookupExistingGmailTmLabels(accountId) {
  if (_gmailTagLabelCache.has(accountId)) return _gmailTagLabelCache.get(accountId);
  try {
    const data = await _gmailFetch(accountId, "/labels");
    const labels = data?.labels || [];
    const tagLabelMap = {};
    for (const tagId of Object.values(ACTION_TAG_IDS)) {
      const existing = labels.find(l => l.name === tagId);
      if (existing) tagLabelMap[tagId] = existing.id;
    }
    _gmailTagLabelCache.set(accountId, tagLabelMap);
    return tagLabelMap;
  } catch (e) {
    console.log(`[GMailTag] _lookupExistingGmailTmLabels ERROR: ${e}`);
    return null;
  }
}

async function _resolveGmailMessageId(accountId, headerMessageId) {
  const result = await _gmailFetch(
    accountId,
    `/messages?q=${encodeURIComponent(`rfc822msgid:${headerMessageId}`)}&maxResults=1`
  );
  return result?.messages?.[0]?.id || null;
}

// ---------------------------------------------------------------------------
// Public API (REMOVE-only)
// ---------------------------------------------------------------------------

/**
 * Remove all `tm_*` Gmail labels from a message (fire-and-forget safe).
 *
 * Called from `onMoved.js` leave-inbox cleanup. No-op on non-Gmail accounts,
 * no-op if the message doesn't exist in Gmail, no-op if no `tm_*` labels
 * exist on this account.
 *
 * @param {number} msgId - WebExtension message ID (used only to resolve
 *   headerMessageId if not supplied by caller).
 * @param {string} accountId - Account ID.
 * @param {string} [headerMessageId] - If available, pass to skip the
 *   `browser.messages.get(msgId)` round-trip (useful after move where msgId
 *   may be stale).
 */
export async function removeTmLabelsFromGmailMessage(msgId, accountId, headerMessageId = "") {
  try {
    if (!await _isGmailAccount(accountId)) return;

    const tagLabels = await _lookupExistingGmailTmLabels(accountId);
    if (!tagLabels || Object.keys(tagLabels).length === 0) return;

    let headerMsgId = headerMessageId ? headerMessageId.replace(/[<>]/g, "") : "";
    if (!headerMsgId) {
      try {
        const header = await browser.messages.get(msgId);
        headerMsgId = (header?.headerMessageId || "").replace(/[<>]/g, "");
      } catch (_) {
        // msgId may be stale after move — without headerMessageId we can't continue
      }
    }
    if (!headerMsgId) return;

    const gmailMsgId = await _resolveGmailMessageId(accountId, headerMsgId);
    if (!gmailMsgId) return;

    const removeLabelIds = Object.values(tagLabels);
    if (removeLabelIds.length === 0) return;

    await _gmailFetch(accountId, `/messages/${gmailMsgId}/modify`, "POST", {
      addLabelIds: [],
      removeLabelIds,
    });

    console.log(`[GMailTag] Removed all tm_* labels on gmailMsgId=${gmailMsgId} (leave-inbox passive decay)`);
  } catch (e) {
    console.log(`[GMailTag] removeTmLabelsFromGmailMessage FAILED: ${e}`);
  }
}
