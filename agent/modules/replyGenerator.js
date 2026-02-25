import { formatTimestampForAgent, getUserName } from "../../chat/modules/helpers.js";
import { executeToolsHeadless } from "../../chat/tools/core.js";
import { SETTINGS } from "./config.js";
import * as idb from "./idbStorage.js";
import { processEditResponse, sendChat } from "./llm.js";
import { getUserCompositionPrompt, getUserKBPrompt } from "./promptGenerator.js";
import { extractBodyFromParts, formatForLog, getUniqueMessageKey, log, safeGetFull, saveChatLog, stripHtml } from "./utils.js";

export const STORAGE_PREFIX = "reply:";
export const TS_PREFIX = "reply:ts:";
const PFX = "[ReplyGen] ";

/**
 * Removes expired reply entries from idb.
 *
 * The TTL is taken from SETTINGS.replyTTLSeconds. Any entry whose stored
 * timestamp is older than `now - TTL` will be deleted.
 */
export async function purgeExpiredReplyEntries() {
    const ttlMs = SETTINGS.replyTTLSeconds * 1000;
    const cutoff = Date.now() - ttlMs;

    const allKeys = await idb.getAllKeys();
    const payloadsToRemove = new Set();
    const metaToRemove = new Set();

    // Get timestamp entries for reply cache
    const timestampKeys = allKeys.filter(key => key.startsWith(TS_PREFIX));
    const timestampEntries = await idb.get(timestampKeys);

    for (const [key, val] of Object.entries(timestampEntries)) {
        const ts = val?.ts ?? 0;
        if (typeof ts !== "number" || ts < cutoff) {
            // Derive payload key from meta key
            const uniqueKey = key.slice(TS_PREFIX.length);
            const payloadKey = STORAGE_PREFIX + uniqueKey;
            payloadsToRemove.add(payloadKey);
            metaToRemove.add(key);
        }
    }

    // Robustness: handle legacy/buggy cases where payload exists but meta ts key is missing.
    // Treat any payload without a matching TS_PREFIX meta key as expired to prevent unbounded growth.
    const payloadKeys = allKeys.filter(key => key.startsWith(STORAGE_PREFIX) && !key.startsWith(TS_PREFIX));
    for (const payloadKey of payloadKeys) {
        try {
            const uniqueKey = payloadKey.slice(STORAGE_PREFIX.length);
            const metaKey = TS_PREFIX + uniqueKey;
            if (!timestampEntries || !Object.prototype.hasOwnProperty.call(timestampEntries, metaKey)) {
                payloadsToRemove.add(payloadKey);
            }
        } catch (_) {}
    }

    const toRemove = [...payloadsToRemove, ...metaToRemove];
    if (toRemove.length > 0) {
        await idb.remove(toRemove);
        const removedPayload = payloadsToRemove.size;
        const removedMeta = metaToRemove.size;
        const orphanedPayload = Math.max(0, removedPayload - removedMeta);
        log(`${PFX}Purged ${toRemove.length} expired reply entries (payload=${removedPayload}, meta=${removedMeta}, payloadWithoutMeta=${orphanedPayload}).`);
    }
}

async function _persistReply(key, replyText) {
    try {
        const payloadKey = STORAGE_PREFIX + key;
        const metaKey = TS_PREFIX + key;
        const existing = await idb.get(payloadKey);
        const hasKey = existing && Object.prototype.hasOwnProperty.call(existing, payloadKey);
        const entry = hasKey ? existing[payloadKey] : undefined;
        const hasFinalPayload = entry && typeof entry.reply === "string";

        if (hasFinalPayload) {
            // Touch only: update timestamp meta, do not overwrite payload
            await idb.set({ [metaKey]: { ts: Date.now() } });
            log(`${PFX}Touched existing cached reply for ${key} (meta ts updated)`);
            return;
        }

        const payload = {
            reply: replyText,
            ts: Date.now(),
        };
        await idb.set({ [payloadKey]: payload });
        await idb.set({ [metaKey]: { ts: Date.now() } });
        log(`${PFX}Cached reply stored under ${payloadKey}`);
    } catch (e) {
        log(`${PFX}Failed to persist reply for ${key}: ${e}`, "error");
    }
}

/**
 * Generates a cached reply for the given thread using the local Ollama
 * backend and stores the result in storage.
 *
 * This mirrors the logic previously done by the Python backend workers.
 *
 * @param {string} preSessionKey – Cache key to save the result under.
 * @param {Array<object>} threadHistory – Array of messages (most recent last).
 * @param {object} details – Additional fields: { subject, from, to, cc }
 */
export async function cacheReply(uniqueMessageKey, messageHeader, details = {}, ignoreSemaphore = false) {

    // Load user composition instructions
    const userCompositionPrompt = await getUserCompositionPrompt();

    // Load user knowledge base content
    let userKBContent = "";
    try {
        userKBContent = (await getUserKBPrompt()) || "";
        console.log(`[Compose/edit] Loaded user KB content (${userKBContent.length} chars) for new conversation.`);
    } catch (e) {
        console.log(`[Compose/edit] Failed to load user KB content: ${e}`, "warn");
        userKBContent = ""; // fallback to empty if loading fails
    }

    // Get user name
    const userName = await getUserName({ fullname: true });

    // Get the body from the full message to send to the LLM
    const full = await safeGetFull(messageHeader.id);
    let bodyHtml = await extractBodyFromParts(full, messageHeader.id);
    const plainBody = stripHtml(bodyHtml || "");

    // Format recipients for the reply we're writing (who we're sending to)
    const replyTo = details.to || "";
    const replyCc = details.cc || "";
    const recipientLines = [];
    if (replyTo) recipientLines.push(`To: ${replyTo}`);
    if (replyCc) recipientLines.push(`Cc: ${replyCc}`);
    const recipientsFormatted = recipientLines.join("\n");

    // Build single consolidated message that backend will process
    // Uses the same flow as edit_reply for consistency
    const systemMsg = {
        role: "system",
        content: "system_prompt_compose",
        mode: "precache_reply",
        user_name: userName,
        user_composition_prompt: userCompositionPrompt || "",
        // Variables for email_edit_common.md
        recipients_formatted: recipientsFormatted,
        current_subject: details.subject || "",
        current_body: "", // Empty - we're generating from scratch
        user_request: "Write a reply to this email.", // Default request for precache
        user_kb_content: userKBContent,
        current_time: formatTimestampForAgent(),
        // Variables for email_edit_reply.md (original email metadata)
        body: plainBody, // Gets split into message/quotes_section by backend
        related_date: details.related_date || "",
        related_subject: details.related_subject || "",
        related_from: details.related_from || "",
        related_to: details.related_to || "",
        related_cc: details.related_cc || "",
    };
    
    // Create an isolated ID translation context so concurrent reply generations
    // don't contaminate each other's or the proactive check-in's idMap.
    let idContext;
    try {
        const { createIsolatedContext } = await import("../../chat/modules/idTranslator.js");
        idContext = createIsolatedContext();
    } catch (e) {
        log(`${PFX}Failed to create isolated idContext: ${e}`, "warn");
    }

    // Use sendChat with headless tool executor for reply generation
    // Backend will filter tools based on system_prompt_compose config
    const scopedExecutor = (toolCalls, tokenUsage) => executeToolsHeadless(toolCalls, tokenUsage, idContext);
    const response = await sendChat([systemMsg], {
        disableTools: false,
        ignoreSemaphore,
        onToolExecution: scopedExecutor,
    });

    // Handle error response
    if (response?.err) {
        log(`${PFX}LLM error for reply key ${uniqueMessageKey}: ${response.err}`, "error");
        return;
    }

    const assistantResp = response?.assistant || "";
    if (!assistantResp) {
        log(`${PFX}LLM returned empty response for reply key ${uniqueMessageKey}`, "error");
        return;
    }

    // Parse the assistant text using the same parser as edit_reply
    const parsed = processEditResponse(assistantResp);

    // Extract the body from the parsed response (edit flow returns subject + body)
    const replyBody = parsed.body || parsed.message || assistantResp;

    // Persist final reply only.
    await _persistReply(uniqueMessageKey, replyBody);

    // Save chat log for debugging/auditing.
    try {
        await saveChatLog("tabmail_reply", uniqueMessageKey, [systemMsg], assistantResp);
    } catch (e) {
        log(`${PFX}Failed to save chat log: ${e}`, "error");
    }

    // Final confirmation
    log(`${PFX}Reply generation completed for key ${uniqueMessageKey}`);
}

/**
 * A set to keep track of message IDs for which a reply request is
 * currently being prepared or sent. This prevents duplicate requests
 * from being fired if the proactive scan runs again before the previous
 * one has fully completed.
 */
const replyRequestsInFlight = new Set();

/**
 * Builds the thread history and sends a reply request to the backend.
 * This can be triggered proactively or reactively with priority.
 * @param {number} messageId - The ID of the message to start from.
 * @param {boolean} isPriority - If true, tells the backend to prioritize this job.
 */
export async function createReply(messageId, isPriority = false) {
    if (replyRequestsInFlight.has(messageId)) {
        log(`- Info: Reply request for message ${messageId} is already in flight. Skipping.`);
        return;
    }

    // Use in-memory de-duplication only; avoid IDB stubs to prevent stale entries.
    log(`- Info: Starting in-memory in-flight reply generation for message ${messageId}.`);

    try {
        // Before marking in-flight, perform a stub-independent existence check in IDB.
        const preSessionKey = await getUniqueMessageKey(messageId);
        if (!preSessionKey) {
            log(`- WARN: Could not create reply key for message ${messageId}. Aborting reply creation.`);
            throw new Error(`Could not create reply key for message ${messageId}`);
        }
        const replyKey = STORAGE_PREFIX + preSessionKey;
        try {
            const existing = await idb.get(replyKey);
            const hasFinal = existing && Object.prototype.hasOwnProperty.call(existing, replyKey) && typeof existing[replyKey]?.reply === "string";
            if (hasFinal) {
                log(`[Reply] Cache HIT for message ${messageId} (${formatForLog(preSessionKey, SETTINGS.logTruncateLength)}). Skipping creation.`);
                // Touch the cache entry by updating its timestamp
                const metaKey = TS_PREFIX + preSessionKey;
                await idb.set({ [metaKey]: { ts: Date.now() } });
                return;
            }
            log(`[Reply] Cache MISS for message ${messageId} (${formatForLog(preSessionKey, SETTINGS.logTruncateLength)}) - generating via LLM...`);
        } catch (e) {
            log(`- WARN: IDB existence check failed for message ${messageId}: ${e}`);
        }

        replyRequestsInFlight.add(messageId);

        // Check cache again after adding to in-flight set (in case another call populated it)
        try {
            const existingAfterInFlight = await idb.get(replyKey);
            const hasFinalAfterInFlight = existingAfterInFlight && Object.prototype.hasOwnProperty.call(existingAfterInFlight, replyKey) && typeof existingAfterInFlight[replyKey]?.reply === "string";
            if (hasFinalAfterInFlight) {
                log(`[Reply] Cache HIT after in-flight check for message ${messageId} (${formatForLog(preSessionKey, SETTINGS.logTruncateLength)}). Skipping creation.`);
                // Touch the cache entry by updating its timestamp
                const metaKey = TS_PREFIX + preSessionKey;
                await idb.set({ [metaKey]: { ts: Date.now() } });
                return;
            }
        } catch (e) {
            log(`- WARN: IDB existence check after in-flight failed for message ${messageId}: ${e}`);
        }

        // --------------------------------------------------------------
        // New logic: just send the email id and header and base on full email content
        // --------------------------------------------------------------

        const messageHeader = await browser.messages.get(messageId);

        await sendReplyRequest(messageId, messageHeader, isPriority);

    } catch (e) {
        log(`- Error preparing reply request for message ${messageId}: ${e}`);
    } finally {
        replyRequestsInFlight.delete(messageId);
    }
}

/**
 * Sends a request to the backend to generate and cache a reply draft for a specific email.
 * @param {number} messageId - The ID of the message to generate a reply for.
 * @param {object} messageHeader - The header object of the message to reply to.
 * @param {boolean} isPriority - If true, the backend should prioritize this reply generation.
 *
 * This function prepares all necessary metadata and context, then triggers the backend
 * to generate a reply draft using the full message content and relevant user/account info.
 * Logs are used throughout for debugging and traceability.
 */
async function sendReplyRequest(messageId, messageHeader, isPriority = false) {
    const preSessionKey = await getUniqueMessageKey(messageId);
    if (!preSessionKey) {
        log(`Could not generate a unique reply key for message ${messageId}. Aborting reply request.`);
        return;
    }

    // Extract metadata from messageHeader for prompt variables
    const lastMessage = messageHeader;
    let fromAddress = "";

    // This logic is crucial for the LLM to know who it is replying "as".
    if (lastMessage.accountId) {
        try {
            const account = await browser.accounts.get(lastMessage.accountId);
            let identity;
            
            if (account) {
                // Find the default identity. The `email` property on the account
                // object corresponds to the email of the default identity.
                identity = account.identities?.find(id => id.email === account.email);
                
                // If we couldn't find a matching default, just take the first one.
                if (!identity && account.identities?.length > 0) {
                    identity = account.identities[0];
                }
            }

            if (identity) {
                // Format the address like "Display Name <email@example.com>" if a name is available.
                if (identity.name) {
                    fromAddress = `"${identity.name}" <${identity.email}>`;
                } else {
                    fromAddress = identity.email;
                }
            }
            // log(`- From address: ${fromAddress}`);
        } catch (e) {
            log(`- WARN: Could not retrieve account for message ${messageId}. Error: ${e}`);
        }
    }
    
    // Fallback for safety.
    if (!fromAddress) {
        fromAddress = (lastMessage.recipients || []).join(', ');
    }

    const details = {
        subject: lastMessage.subject.startsWith("Re: ") ? lastMessage.subject : `Re: ${lastMessage.subject}`,
        from: fromAddress,
        to: lastMessage.author || lastMessage.from || "",
        cc: (lastMessage.recipients || []).join(', '),
        // Original email metadata for context
        related_date: lastMessage.date ? formatTimestampForAgent(new Date(lastMessage.date)) : "",
        related_subject: lastMessage.subject || "",
        related_from: lastMessage.author || lastMessage.from || "",
        related_to: (lastMessage.recipients || []).join(', '),
        related_cc: (lastMessage.ccList || []).join(', '),
    };

    log(`Generating in-addon reply for key: ${formatForLog(preSessionKey, SETTINGS.logTruncateLength)} (Priority: ${isPriority})`);

    try {
        await cacheReply(preSessionKey, messageHeader, details, isPriority);
    } catch (e) {
        log(`CRITICAL: cacheReply failed for key ${preSessionKey}: ${e}`, 'error');
    }
}