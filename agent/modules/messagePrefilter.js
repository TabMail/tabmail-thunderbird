import { log } from "./utils.js";

/**
 * Email pre-filtering utilities to determine if messages should skip cached reply generation.
 *
 * This module provides functions to detect:
 * - No-reply email addresses
 *
 * These filters help avoid generating cached replies for emails that don't expect responses,
 * such as automated notifications from no-reply addresses.
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
 * Analyzes an email to determine if it should skip cached reply generation.
 * Checks for no-reply addresses.
 *
 * @param {object} messageHeader - The message header from browser.messages.get()
 * @returns {Promise<{isNoReply: boolean, skipCachedReply: boolean}>}
 */
export async function analyzeEmailForReplyFilter(messageHeader) {
    try {
        log(`[EmailFilter] Analyzing email ${messageHeader.id} for reply filter`);

        // Check for no-reply address (quick check, no fetch needed)
        const isNoReply = isNoReplyAddress(messageHeader.author);
        log(`[EmailFilter] Message ${messageHeader.id}: isNoReply=${isNoReply} (author: ${messageHeader.author})`);

        const skipCachedReply = isNoReply;
        log(`[EmailFilter] Message ${messageHeader.id}: skipCachedReply=${skipCachedReply}`);

        return {
            isNoReply,
            skipCachedReply
        };
    } catch (e) {
        log(`[EmailFilter] Error analyzing email ${messageHeader.id}: ${e}`, 'error');
        // On error, don't skip - safer to generate a reply than to miss one
        return {
            isNoReply: false,
            skipCachedReply: false
        };
    }
}

