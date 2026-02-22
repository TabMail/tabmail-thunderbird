import { extractBodyFromParts, log, safeGetFull, stripHtml } from "./utils.js";

/**
 * Email pre-filtering utilities for reply skip decisions and LLM prompt context.
 *
 * This module provides functions to detect:
 * - No-reply email addresses
 * - Emails with unsubscribe links or headers
 *
 * `isNoReply` is used to skip reply generation (hard filter).
 * `hasUnsubscribe` is passed as LLM context for summary/action classification only
 * (NOT used to skip reply generation — too aggressive for mailing list emails).
 */

/**
 * Checks if an email address is a no-reply address.
 * @param {string} author - The author field from message header (e.g., "Name <email@domain.com>" or "email@domain.com")
 * @returns {boolean} - True if the email is a no-reply address
 */
function isNoReplyAddress(author) {
    if (!author || typeof author !== 'string') return false;

    // Extract email from author field - handle both "Name <email>" and plain "email" formats
    let email = author.match(/<(.+?)>/)?.[1];
    if (!email) {
        // Try plain email format (no angle brackets)
        const plainEmailMatch = author.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/);
        email = plainEmailMatch?.[0];
    }

    if (!email) return false;

    // Check for common no-reply patterns (case insensitive)
    const emailLower = email.toLowerCase();
    const noReplyPatterns = [
        'noreply',
        'no-reply',
        'no_reply',
        'donotreply',
        'do-not-reply',
        'do_not_reply',
        'notifications',
        'automated',
        'invitations',
        'announcements',
        'updates',
        'newsletters',
        'newsletter',
        'digests',
        'digest',
    ];

    return noReplyPatterns.some(pattern => emailLower.includes(pattern));
}

/**
 * Checks if an email has unsubscribe link or header.
 * Used as LLM context for summary/action classification, NOT for reply skip.
 * @param {object} fullMessage - The full message object from browser.messages.getFull()
 * @param {string} bodyText - The plain text body of the email
 * @returns {boolean} - True if the email has unsubscribe link or header
 */
function hasUnsubscribeLink(fullMessage, bodyText) {
    if (!fullMessage) return false;

    // Check for List-Unsubscribe header (most reliable method)
    const checkHeaders = (headers) => {
        if (!headers) return false;

        const listUnsubscribe = headers['list-unsubscribe'] || headers['List-Unsubscribe'];
        if (listUnsubscribe && Array.isArray(listUnsubscribe) && listUnsubscribe.length > 0) {
            return true;
        }

        const precedence = headers['precedence'] || headers['Precedence'];
        if (precedence && Array.isArray(precedence)) {
            const precedenceValue = precedence[0]?.toLowerCase();
            if (precedenceValue === 'bulk' || precedenceValue === 'list') {
                return true;
            }
        }

        return false;
    };

    if (fullMessage.headers && checkHeaders(fullMessage.headers)) {
        return true;
    }

    const checkParts = (parts) => {
        if (!parts || !Array.isArray(parts)) return false;
        for (const part of parts) {
            if (part.headers && checkHeaders(part.headers)) return true;
            if (part.parts && checkParts(part.parts)) return true;
        }
        return false;
    };

    if (fullMessage.parts && checkParts(fullMessage.parts)) {
        return true;
    }

    // Fallback: Check body text for common unsubscribe patterns
    if (bodyText && typeof bodyText === 'string') {
        const bodyLower = bodyText.toLowerCase();
        const unsubscribePatterns = [
            'unsubscribe', 'opt out', 'opt-out',
            'update your preferences', 'manage your subscription',
            'manage subscription', 'email preferences',
        ];
        if (unsubscribePatterns.some(pattern => bodyLower.includes(pattern))) {
            if (bodyLower.includes('http') || bodyLower.includes('www') || bodyLower.includes('click')) {
                return true;
            }
        }
    }

    return false;
}

/**
 * Analyzes an email for reply skip decision and LLM prompt context.
 *
 * skipCachedReply is based on isNoReply ONLY (not hasUnsubscribe — too aggressive for mailing lists).
 * hasUnsubscribe is still computed and returned for use as LLM context in summary/action.
 *
 * @param {object} messageHeader - The message header from browser.messages.get()
 * @param {object} fullMessage - (Optional) The full message from browser.messages.getFull()
 * @param {string} bodyText - (Optional) The plain text body
 * @returns {Promise<{isNoReply: boolean, hasUnsubscribe: boolean, skipCachedReply: boolean}>}
 */
export async function analyzeEmailForReplyFilter(messageHeader, fullMessage = null, bodyText = null) {
    try {
        log(`[EmailFilter] Analyzing email ${messageHeader.id} for reply filter`);

        const isNoReply = isNoReplyAddress(messageHeader.author);
        log(`[EmailFilter] Message ${messageHeader.id}: isNoReply=${isNoReply} (author: ${messageHeader.author})`);

        // Compute hasUnsubscribe for LLM context (NOT used in skipCachedReply)
        let hasUnsubscribe = false;
        let full = fullMessage;
        let body = bodyText;

        if (!full || !body) {
            try {
                log(`[EmailFilter] Message ${messageHeader.id}: Fetching full message for unsubscribe check (using cached safeGetFull)`);
                full = full || await safeGetFull(messageHeader.id);
                if (!body) {
                    const bodyHtml = await extractBodyFromParts(full, messageHeader.id);
                    body = stripHtml(bodyHtml || "");
                }
            } catch (fetchErr) {
                log(`[EmailFilter] Message ${messageHeader.id}: Failed to fetch full message: ${fetchErr}`, 'warn');
            }
        }

        hasUnsubscribe = hasUnsubscribeLink(full, body);
        log(`[EmailFilter] Message ${messageHeader.id}: hasUnsubscribe=${hasUnsubscribe}`);

        // Only isNoReply drives reply skip — hasUnsubscribe is too aggressive for mailing lists
        const skipCachedReply = isNoReply;
        log(`[EmailFilter] Message ${messageHeader.id}: skipCachedReply=${skipCachedReply}`);

        return {
            isNoReply,
            hasUnsubscribe,
            skipCachedReply
        };
    } catch (e) {
        log(`[EmailFilter] Error analyzing email ${messageHeader.id}: ${e}`, 'error');
        return {
            isNoReply: false,
            hasUnsubscribe: false,
            skipCachedReply: false
        };
    }
}

