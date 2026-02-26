// Thread Conversation Module
// Handles fetching, enriching, and sending thread conversation data to content scripts
// Also handles thread bubble actions (mark read, compose, download attachment)

import { SETTINGS } from "../../agent/modules/config.js";
import { ACTION_TAG_IDS } from "../../agent/modules/tagHelper.js";
import { getIdentityForMessage, safeGetFull, stripHtml } from "../../agent/modules/utils.js";

// Cache identity email -> display name (for "Identity:email:..." author strings)
let _identityEmailToNameCache = null;
let _identityEmailToNameCacheBuilt = false;

async function getIdentityEmailToNameMap() {
    if (_identityEmailToNameCacheBuilt && _identityEmailToNameCache) {
        return _identityEmailToNameCache;
    }
    const map = new Map();
    try {
        const accounts = await browser.accounts.list();
        for (const acc of accounts || []) {
            const ids = Array.isArray(acc?.identities) ? acc.identities : [];
            for (const ident of ids) {
                try {
                    const email = String(ident?.email || "").trim().toLowerCase();
                    const name = String(ident?.name || "").trim();
                    if (email && name) {
                        map.set(email, name);
                    }
                } catch (_) {}
            }
        }
        console.log(`[TabMail ThreadConv] Identity map built: ${map.size} identity email(s)`);
    } catch (e) {
        console.log(`[TabMail ThreadConv] Failed to build identity map: ${e}`);
    }
    _identityEmailToNameCache = map;
    _identityEmailToNameCacheBuilt = true;
    return map;
}

function formatSenderDisplayName(rawAuthor, identityEmailToName) {
    const s = String(rawAuthor || "").trim();
    if (!s) return "Unknown";

    // Thunderbird sometimes surfaces self as "Identity:email:me@example.com"
    if (s.startsWith("Identity:")) {
        // Try to extract email from a few known patterns.
        let email = "";
        try {
            const m = s.match(/^Identity:(?:email:)?(.+)$/);
            email = (m && m[1]) ? String(m[1]).trim() : "";
        } catch (_) {}
        const key = email.toLowerCase();
        if (key && identityEmailToName && identityEmailToName.get(key)) {
            return identityEmailToName.get(key);
        }
        // If we can't resolve, at least remove the Identity prefix for readability.
        if (email) {
            console.log(`[TabMail ThreadConv] Identity author not resolved to name: raw="${s}" email="${email}"`);
            return email;
        }
        console.log(`[TabMail ThreadConv] Identity author format unexpected: raw="${s}"`);
        return "Me";
    }

    // "Name <email>"
    try {
        const m = s.match(/^([^<]+)\s*</);
        if (m && m[1]) return m[1].trim();
    } catch (_) {}

    return s;
}

function getFirstActionTagId(tags) {
    try {
        const arr = Array.isArray(tags) ? tags : [];
        if (arr.includes(ACTION_TAG_IDS.reply)) return ACTION_TAG_IDS.reply;
        if (arr.includes(ACTION_TAG_IDS.archive)) return ACTION_TAG_IDS.archive;
        if (arr.includes(ACTION_TAG_IDS.delete)) return ACTION_TAG_IDS.delete;
        if (arr.includes(ACTION_TAG_IDS.none)) return ACTION_TAG_IDS.none;
    } catch (_) {}
    return null;
}

/**
 * Mark a thread message as read
 */
export function handleThreadMarkRead(messageId, meta = {}) {
    const msgId = typeof messageId === "number" ? messageId : Number(messageId);
    const reason = String(meta?.reason || "");
    console.log(`[TabMail ThreadConv] Thread bubble: markRead requested id=${msgId} reason="${reason}"`);
    if (!Number.isFinite(msgId)) {
        return Promise.resolve({ ok: false, error: "invalid_message_id" });
    }
    return browser.messages
        .update(msgId, { read: true })
        .then(() => {
            console.log(`[TabMail ThreadConv] Thread bubble: ✓ marked read id=${msgId}`);
            return { ok: true };
        })
        .catch((e) => {
            console.log(`[TabMail ThreadConv] Thread bubble: messages.update(read=true) failed id=${msgId}: ${e}`);
            return { ok: false, error: String(e) };
        });
}

/**
 * Handle compose actions (reply, replyAll, forward) from thread bubbles
 */
export function handleThreadComposeAction(action, messageId) {
    const msgId = typeof messageId === "number" ? messageId : Number(messageId);
    const a = String(action || "");
    console.log(`[TabMail ThreadConv] Thread bubble: compose action requested action="${a}" id=${msgId}`);
    if (!Number.isFinite(msgId)) {
        return Promise.resolve({ ok: false, error: "invalid_message_id" });
    }

    return (async () => {
        // Resolve identity so multi-account users reply/forward from the correct identity.
        let identityId = null;
        try {
            const ident = await getIdentityForMessage(msgId);
            identityId = ident?.identityId || null;
        } catch (eIdent) {
            console.log(`[TabMail ThreadConv] Thread bubble: getIdentityForMessage failed id=${msgId}: ${eIdent}`);
        }

        const details = {};
        if (identityId) details.identityId = identityId;

        if (a === "reply") {
            const replyType = "replyToSender";
            console.log(
                `[TabMail ThreadConv] Thread bubble: beginReply(id=${msgId}, type=${replyType}, identityId=${identityId || "(default)"})`
            );
            await browser.compose.beginReply(msgId, replyType, details);
            return { ok: true, opened: "reply" };
        }

        if (a === "replyAll") {
            const replyType = "replyToAll";
            console.log(
                `[TabMail ThreadConv] Thread bubble: beginReply(id=${msgId}, type=${replyType}, identityId=${identityId || "(default)"})`
            );
            await browser.compose.beginReply(msgId, replyType, details);
            return { ok: true, opened: "replyAll" };
        }

        if (a === "forward") {
            console.log(
                `[TabMail ThreadConv] Thread bubble: beginForward(id=${msgId}, identityId=${identityId || "(default)"})`
            );
            await browser.compose.beginForward(msgId, details);
            return { ok: true, opened: "forward" };
        }

        console.log(`[TabMail ThreadConv] Thread bubble: unknown compose action "${a}" id=${msgId}`);
        return { ok: false, error: "unknown_action" };
    })().catch((e) => {
        console.log(`[TabMail ThreadConv] Thread bubble: compose action failed action="${a}" id=${msgId}: ${e}`);
        return { ok: false, error: String(e) };
    });
}

/**
 * Handle attachment download requests from thread bubbles
 */
export async function handleThreadDownloadAttachment(messageId, partName, filename) {
    const msgId = typeof messageId === "number" ? messageId : Number(messageId);
    const part = String(partName || "");
    const fname = String(filename || "attachment");
    console.log(`[TabMail ThreadConv] Thread bubble: downloading attachment messageId=${msgId} partName="${part}" filename="${fname}"`);

    if (!Number.isFinite(msgId) || !part) {
        return { ok: false, error: "invalid_parameters" };
    }

    try {
        // Get attachment file as a File object
        const file = await browser.messages.getAttachmentFile(msgId, part);
        if (!file) {
            console.log(`[TabMail ThreadConv] Thread bubble: getAttachmentFile returned null for messageId=${msgId} partName="${part}"`);
            return { ok: false, error: "attachment_not_found" };
        }

        // Create a blob URL for download
        const blob = new Blob([await file.arrayBuffer()], { type: file.type || "application/octet-stream" });
        const blobUrl = URL.createObjectURL(blob);

        // Use downloads API to save the file
        const downloadId = await browser.downloads.download({
            url: blobUrl,
            filename: fname,
            saveAs: true,
        });

        console.log(`[TabMail ThreadConv] Thread bubble: ✓ download initiated downloadId=${downloadId} filename="${fname}"`);

        // Clean up blob URL after a delay (give browser time to start the download)
        setTimeout(() => {
            try {
                URL.revokeObjectURL(blobUrl);
            } catch (_) {}
        }, 60000);

        return { ok: true, downloadId };
    } catch (e) {
        console.log(`[TabMail ThreadConv] Thread bubble: download attachment failed messageId=${msgId} partName="${part}": ${e}`);
        return { ok: false, error: String(e) };
    }
}

/**
 * Extract body text from message parts (MIME structure)
 */
function extractBodyFromParts(parts, maxLength) {
    if (!parts || !Array.isArray(parts)) return "";
    
    let plainBody = "";
    let htmlBody = "";
    
    function traverse(partList) {
        for (const part of partList) {
            if (!part) continue;
            
            const ct = (part.contentType || "").toLowerCase();
            
            if (ct.startsWith("text/plain") && part.body) {
                plainBody += part.body + "\n";
            } else if (ct.startsWith("text/html") && part.body) {
                htmlBody += part.body + "\n";
            }
            
            if (part.parts && Array.isArray(part.parts)) {
                traverse(part.parts);
            }
        }
    }
    
    traverse(parts);
    
    let body = plainBody.trim() || stripHtml(htmlBody);
    
    if (maxLength > 0 && body.length > maxLength) {
        body = body.substring(0, maxLength) + "…";
    }
    
    return body;
}

/**
 * Fetch thread parent messages and send to the content script for rendering
 */
export async function fetchAndSendThreadConversation(tabId, weMsgId) {
    try {
        console.log(`[TabMail ThreadConv] ═══ Fetching thread conversation for message ${weMsgId} ═══`);
        
        // Check if the threadMessages experiment is available
        console.log(`[TabMail ThreadConv] browser.threadMessages exists: ${!!browser.threadMessages}`);
        console.log(`[TabMail ThreadConv] browser.threadMessages.getThreadParents exists: ${!!(browser.threadMessages && browser.threadMessages.getThreadParents)}`);
        console.log(`[TabMail ThreadConv] browser.threadMessages.getThreadMessages exists: ${!!(browser.threadMessages && browser.threadMessages.getThreadMessages)}`);
        
        if (!browser.threadMessages || !browser.threadMessages.getThreadMessages) {
            console.log("[TabMail ThreadConv] ✗ threadMessages experiment not available - check manifest.json registration");
            return;
        }
        
        const threadConfig = SETTINGS.threadConversation || {};
        console.log(`[TabMail ThreadConv] Thread conversation source: ${threadConfig.source || "folderThread"}`);

        let result = null;
        try {
            if ((threadConfig.source || "folderThread") === "glodaConversation") {
                console.log(`[TabMail ThreadConv] Using Gloda conversation for related messages (cross-folder)`);
                console.log(`[TabMail ThreadConv] browser.glodaSearch exists: ${!!browser.glodaSearch}`);
                console.log(`[TabMail ThreadConv] browser.glodaSearch.getConversationMessages exists: ${!!(browser.glodaSearch && browser.glodaSearch.getConversationMessages)}`);
                if (!browser.glodaSearch || !browser.glodaSearch.getConversationMessages) {
                    console.log("[TabMail ThreadConv] ✗ glodaSearch experiment not available - cannot fetch conversation messages");
                    return;
                }
                const convRes = await browser.glodaSearch.getConversationMessages(weMsgId, {
                    maxMessages: threadConfig.maxConversationMessages,
                });
                result = {
                    success: !!convRes?.success,
                    error: convRes?.error || "",
                    messages: (convRes?.messages || []).map((m) => ({
                        weId: m?.weMsgId ?? null,
                        from: m?.author ?? "",
                        date: (m?.dateMs ? new Date(m.dateMs).toISOString() : null),
                        subject: m?.subject ?? "",
                        folderUri: m?.folderUri ?? "",
                        weFolderId: m?.weFolderId ?? null,
                        headerMessageId: m?.headerMessageId ?? "",
                    })),
                    source: "glodaConversation",
                };
            } else {
                // Fetch thread messages (metadata only from experiment; does not rely on parent chain)
                result = await browser.threadMessages.getThreadMessages(weMsgId, {
                    maxMessages: threadConfig.maxThreadMessages,
                });
                result = { ...result, source: "folderThread" };
            }
        } catch (eCall) {
            console.error("[TabMail ThreadConv] related-messages fetch threw:", eCall);
            // Keep existing top-level catch behavior too.
            throw eCall;
        }

        try {
            console.log(
                `[TabMail ThreadConv] related-messages result: source=${result?.source} success=${!!result?.success} threadId=${result?.threadId} threadParent=${result?.threadParent} totalInThread=${result?.totalInThread} messages=${result?.messages?.length || 0} error="${result?.error || ""}"`
            );
        } catch (_) {}
        
        if (!result.success) {
            console.log(`[TabMail ThreadConv] Failed to get thread messages: ${result.error}`);
            return;
        }
        
        if (!result.messages || result.messages.length === 0) {
            console.log("[TabMail ThreadConv] No related messages returned for thread (thread enumeration empty in this folder)");
            return;
        }
        
        try {
            const previewMax = threadConfig.previewLogSampleMax;
            const preview = result.messages.slice(0, previewMax).map(m => ({ weId: m?.weId, date: m?.date, from: m?.from }));
            console.log(`[TabMail ThreadConv] Thread messages preview (first ${previewMax}):`, JSON.stringify(preview));
        } catch (_) {}

        // Optionally exclude the currently displayed message to avoid duplication in the bubble list.
        // IMPORTANT: For Gmail label semantics + Gloda cross-folder conversations, the SAME email can
        // exist as multiple WebExtension message IDs (weId) across folders. In those cases we must
        // exclude/dedupe by headerMessageId (Message-ID) to avoid showing a duplicate "copy" bubble.
        const normalizeHeaderMessageId = (v) => {
            try { return String(v || "").replace(/[<>]/g, "").trim(); } catch (_) { return ""; }
        };
        const toDateMs = (d) => {
            try {
                if (!d) return null;
                if (typeof d === "number" && Number.isFinite(d)) return d;
                if (typeof d?.getTime === "function") {
                    const t = d.getTime();
                    return Number.isFinite(t) ? t : null;
                }
                const t = new Date(d).getTime();
                return Number.isFinite(t) ? t : null;
            } catch (_) {
                return null;
            }
        };
        const excludeCurrentMessage = threadConfig.excludeCurrentMessage !== false;

        // Try to capture the current message's headerMessageId so we can exclude its other folder copies.
        let currentHeaderMessageId = "";
        let currentMessageDateMs = null;
        if (excludeCurrentMessage) {
            try {
                const currentHeader = await browser.messages.get(weMsgId);
                currentHeaderMessageId = normalizeHeaderMessageId(currentHeader?.headerMessageId || "");
                currentMessageDateMs = toDateMs(currentHeader?.date);
                console.log(
                    `[TabMail ThreadConv] Current message identity: weId=${weMsgId} headerMessageId=${currentHeaderMessageId || "(missing)"} dateMs=${Number.isFinite(currentMessageDateMs) ? currentMessageDateMs : "(missing)"}`
                );
            } catch (eCur) {
                console.log(`[TabMail ThreadConv] Failed to load current message header for dedupe: ${eCur}`);
            }
        }

        // First: exclude the current message (by weId, and by headerMessageId if present).
        const excluded = (excludeCurrentMessage && Array.isArray(result.messages))
            ? result.messages.filter((m) => {
                if (!m || !m.weId) return false;
                if (m.weId === weMsgId) return false;
                const mid = normalizeHeaderMessageId(m.headerMessageId || "");
                if (currentHeaderMessageId && mid && mid === currentHeaderMessageId) return false;
                return true;
            })
            : (result.messages || []);

        // Second: dedupe remaining related messages by headerMessageId (when present).
        // This prevents duplicates caused by multiple folder copies (Inbox/All Mail/Sent, etc).
        const seen = new Map(); // headerMessageId -> first message
        const threadMessages = [];
        const dropped = new Map(); // headerMessageId -> [{weId, folderUri}, ...]
        for (const m of excluded) {
            if (!m || !m.weId) continue;
            const mid = normalizeHeaderMessageId(m.headerMessageId || "");
            if (!mid) {
                threadMessages.push(m);
                continue;
            }
            if (!seen.has(mid)) {
                seen.set(mid, m);
                threadMessages.push(m);
            } else {
                const arr = dropped.get(mid) || [];
                arr.push({ weId: m.weId, folderUri: m.folderUri || "" });
                dropped.set(mid, arr);
            }
        }
        if (dropped.size > 0) {
            try {
                const sampleMax = threadConfig.dedupeLogSampleMax;
                const sample = [];
                for (const [mid, arr] of dropped.entries()) {
                    const kept = seen.get(mid);
                    sample.push({
                        headerMessageId: mid,
                        kept: { weId: kept?.weId ?? null, folderUri: kept?.folderUri ?? "" },
                        dropped: arr,
                    });
                    if (sample.length >= sampleMax) break;
                }
                console.log(
                    `[TabMail ThreadConv] Deduped related messages by headerMessageId: droppedKeys=${dropped.size} droppedTotal=${Array.from(dropped.values()).reduce((n, a) => n + (a?.length || 0), 0)} sample=${JSON.stringify(sample)}`
                );
            } catch (_) {}
        }

        // Third: optionally filter out messages that are "later" than the current message.
        // (Gloda conversation can include the full thread including future replies.)
        const excludeFutureMessages = threadConfig.excludeFutureMessages !== false;
        let filteredThreadMessages = threadMessages;
        if (excludeFutureMessages) {
            if (!Number.isFinite(currentMessageDateMs)) {
                console.log(
                    `[TabMail ThreadConv] Future-message filter enabled but current message date is missing; skipping filter (weId=${weMsgId})`
                );
            } else {
                const droppedFuture = [];
                let droppedFutureCount = 0;
                let droppedNoDateCount = 0;
                filteredThreadMessages = [];
                for (const m of threadMessages) {
                    const mDateMs = toDateMs(m?.date);
                    if (!Number.isFinite(mDateMs)) {
                        droppedNoDateCount++;
                        continue;
                    }
                    if (mDateMs > currentMessageDateMs) {
                        droppedFutureCount++;
                        // Keep a small sample for logs (config-controlled).
                        try {
                            const sampleMax = threadConfig.futureDropLogSampleMax;
                            if (droppedFuture.length < sampleMax) {
                                droppedFuture.push({
                                    weId: m?.weId ?? null,
                                    date: m?.date ?? null,
                                    headerMessageId: m?.headerMessageId ?? "",
                                    subject: m?.subject ?? "",
                                    folderUri: m?.folderUri ?? "",
                                });
                            }
                        } catch (_) {}
                        continue;
                    }
                    filteredThreadMessages.push(m);
                }
                console.log(
                    `[TabMail ThreadConv] Future-message filter applied: currentDateMs=${currentMessageDateMs} kept=${filteredThreadMessages.length} droppedFuture=${droppedFutureCount} droppedNoDate=${droppedNoDateCount} sample=${JSON.stringify(droppedFuture)}`
                );
            }
        }

        if (!filteredThreadMessages || filteredThreadMessages.length === 0) {
            console.log(`[TabMail ThreadConv] Thread messages empty after excluding current message; nothing to render (before=${result.messages.length} after=0 excludeCurrentMessage=${excludeCurrentMessage})`);
            return;
        }

        console.log(`[TabMail ThreadConv] Found ${filteredThreadMessages.length} related thread messages, fetching body content`);
        
        // Fetch body content for each message via WebExtension API
        const includeBody = threadConfig.includeBody !== false;
        const bodyMaxLength = threadConfig.bodyMaxLength;
        const previewLines = threadConfig.previewLines;

        const identityEmailToName = await getIdentityEmailToNameMap();
        
        const messagesWithBody = await Promise.all(filteredThreadMessages.map(async (msg) => {
            const enrichedMsg = { ...msg, body: "", bodyIsHtml: false };

            // Enrich headers (author/recipients/cc) so expanded UI can show metadata.
            try {
                const header = await browser.messages.get(msg.weId);
                const rawAuthor = header?.author || msg.from || "";
                enrichedMsg.from = formatSenderDisplayName(rawAuthor, identityEmailToName);

                // Keep as arrays; content script will decide how to render.
                enrichedMsg.recipients = Array.isArray(header?.recipients) ? header.recipients : [];
                enrichedMsg.ccList = Array.isArray(header?.ccList) ? header.ccList : [];

                // Thread bubble styling/behavior fields.
                enrichedMsg.read = !!header?.read;
                enrichedMsg.tags = Array.isArray(header?.tags) ? header.tags : [];
                enrichedMsg.actionTagId = getFirstActionTagId(enrichedMsg.tags);

                // Fetch attachment metadata for display in thread bubbles
                try {
                    const attachments = await browser.messages.listAttachments(msg.weId);
                    enrichedMsg.attachments = (attachments || []).map((att) => ({
                        partName: att?.partName || "",
                        name: att?.name || "Attachment",
                        size: att?.size || 0,
                        contentType: att?.contentType || "",
                    }));
                    if (enrichedMsg.attachments.length > 0) {
                        console.log(
                            `[TabMail ThreadConv] Thread bubble attachments weId=${msg.weId} count=${enrichedMsg.attachments.length}`
                        );
                    }
                } catch (attErr) {
                    console.log(`[TabMail ThreadConv] Failed to list attachments for message ${msg.weId}: ${attErr}`);
                    enrichedMsg.attachments = [];
                }

                try {
                    console.log(
                        `[TabMail ThreadConv] Thread bubble enrich weId=${msg.weId} read=${enrichedMsg.read} actionTagId=${enrichedMsg.actionTagId || "(none)"} tagsCount=${enrichedMsg.tags.length} attachments=${enrichedMsg.attachments?.length || 0}`
                    );
                } catch (_) {}
            } catch (hdrErr) {
                console.log(`[TabMail ThreadConv] Failed to get header details for message ${msg.weId}: ${hdrErr}`);
                // Keep existing from if present; still attach empty arrays for predictable rendering.
                enrichedMsg.recipients = [];
                enrichedMsg.ccList = [];
                enrichedMsg.read = false;
                enrichedMsg.tags = [];
                enrichedMsg.actionTagId = null;
                enrichedMsg.attachments = [];
                // Also normalize Identity format if it slipped through.
                try {
                    enrichedMsg.from = formatSenderDisplayName(enrichedMsg.from || msg.from || "", identityEmailToName);
                } catch (_) {}
            }

            // Pass UI config down (no hardcoded numeric values in the content script).
            enrichedMsg.previewLines = previewLines;
            
            if (includeBody && msg.weId) {
                try {
                    const fullMsg = await safeGetFull(msg.weId);
                    if (fullMsg?.__tmSynthetic) {
                        // FTS cache hit — body is already plain text
                        let body = fullMsg.body || "";
                        if (bodyMaxLength > 0 && body.length > bodyMaxLength) {
                            body = body.substring(0, bodyMaxLength) + "…";
                        }
                        enrichedMsg.body = body;
                    } else if (fullMsg && fullMsg.parts) {
                        enrichedMsg.body = extractBodyFromParts(fullMsg.parts, bodyMaxLength);
                    }
                } catch (bodyErr) {
                    console.log(`[TabMail ThreadConv] Failed to get body for message ${msg.weId}: ${bodyErr}`);
                }
            }
            
            return enrichedMsg;
        }));

        // Sort oldest-first so the content script can render newest-first consistently.
        messagesWithBody.sort((a, b) => {
            const da = a?.date ? new Date(a.date).getTime() : 0;
            const db = b?.date ? new Date(b.date).getTime() : 0;
            return da - db;
        });
        
        console.log(`[TabMail ThreadConv] Sending ${messagesWithBody.length} messages to content script`);
        
        // Font sizing is CSS-first in the content scripts now; no JS sizing via prefs.
        console.log(`[TabMail ThreadConv] Skipping font prefs for bubble sizing (cssSizing)`);

        // Send to the content script
        try {
            await browser.tabs.sendMessage(tabId, {
                command: "displayThreadConversation",
                messages: messagesWithBody,
            });
            console.log(`[TabMail ThreadConv] Thread conversation sent to tab ${tabId}`);
        } catch (sendErr) {
            console.log(`[TabMail ThreadConv] Failed to send thread conversation to tab: ${sendErr}`);
        }
        
    } catch (e) {
        console.error("[TabMail ThreadConv] Error fetching thread conversation:", e);
    }
}
