import { log } from "./utils.js";

// In-memory cache for this MV3 service worker lifetime.
let _cachedUserEmailSet = null; // Set<string>

async function _loadUserEmailSet() {
  try {
    const accounts = await browser.accounts.list();
    const emails = new Set();

    for (const acc of accounts || []) {
      try {
        // Skip Local Folders and other non-email accounts (no identities).
        if (acc?.type === "none" || acc?.incomingServer?.type === "none") {
          continue;
        }

        if (acc?.email) {
          emails.add(String(acc.email).trim().toLowerCase());
        }

        const ids = Array.isArray(acc?.identities) ? acc.identities : [];
        for (const identity of ids) {
          if (identity?.email) {
            emails.add(String(identity.email).trim().toLowerCase());
          }
        }
      } catch (_) {}
    }

    try {
      log(`[SenderFilter] Loaded ${emails.size} user email(s) from accounts/identities`);
    } catch (_) {}

    return emails;
  } catch (e) {
    try {
      log(`[SenderFilter] Failed to load user emails: ${e}`, "warn");
    } catch (_) {}
    return new Set();
  }
}

export async function getUserEmailSetCached() {
  if (_cachedUserEmailSet) return _cachedUserEmailSet;
  _cachedUserEmailSet = await _loadUserEmailSet();
  return _cachedUserEmailSet;
}

export function extractEmailFromAuthor(author) {
  try {
    const a = String(author || "");
    const angle = a.match(/<(.+?)>/)?.[1];
    if (angle) return String(angle).trim().toLowerCase();
    const plain = a.match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/)?.[0];
    return plain ? String(plain).trim().toLowerCase() : "";
  } catch (_) {
    return "";
  }
}

/**
 * Returns true if this message appears to be from one of the user's own accounts/identities.
 * If we cannot determine user emails, returns false (do not filter) to avoid false negatives.
 */
export async function isInternalSender(messageHeader) {
  try {
    const userEmails = await getUserEmailSetCached();
    if (!userEmails || userEmails.size === 0) {
      // Same policy as FolderScan: if we can't detect identities, don't filter.
      return false;
    }
    const authorEmail = extractEmailFromAuthor(messageHeader?.author);
    if (!authorEmail) return false;
    return userEmails.has(authorEmail);
  } catch (_) {
    return false;
  }
}


