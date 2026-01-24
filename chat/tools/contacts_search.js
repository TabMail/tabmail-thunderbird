// contacts_search.js – search Thunderbird address books for contacts by name or email
// Thunderbird 140, MV3

import { log } from "../../agent/modules/utils.js";
import { CHAT_SETTINGS } from "../modules/chatConfig.js";
import { findContactsRawRows, parseVCardBasic } from "../modules/contacts.js";

export async function run(args = {}, options = {}) {
  try {
    const queryText = (args?.query || "").trim();
    const limitRaw = args?.limit;
    let limit = Number.isFinite(limitRaw) ? limitRaw : Number(limitRaw);
    if (!Number.isFinite(limit) || limit <= 0) {
      const cfgDefault = Number(CHAT_SETTINGS?.contactsDefaultLimit);
      limit = Number.isFinite(cfgDefault) && cfgDefault > 0 ? cfgDefault : 25;
    }
    const cfgMax = Number(CHAT_SETTINGS?.contactsMaxLimit);
    if (Number.isFinite(cfgMax) && cfgMax > 0 && limit > cfgMax) limit = cfgMax;
    const timeoutMs = Number(CHAT_SETTINGS?.contactsQueryTimeoutMs);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      log(`[TMDBG Tools] contacts_search: invalid timeout config CHAT_SETTINGS.contactsQueryTimeoutMs='${CHAT_SETTINGS?.contactsQueryTimeoutMs}'`, "error");
      return { error: "invalid timeout configuration" };
    }

    if (!queryText) {
      log(`[TMDBG Tools] contacts_search: missing query`, "error");
      return { error: "missing query" };
    }

    log(`[TMDBG Tools] contacts_search: starting query='${queryText}' limit=${limit} timeoutMs=${timeoutMs}`);

    // Get raw rows first - this ensures we have consistent data source for both candidates and IDs
    const rawRows = await findContactsRawRows(queryText, { timeoutMs });
    log(`[TMDBG Tools] contacts_search: rawRows=${rawRows.length}`);

    if (rawRows.length === 0) {
      log(`[TMDBG Tools] contacts_search: no raw rows found for query='${queryText}'`);
      return "";
    }

    // Process raw rows to create candidates with proper deduplication
    const candidates = [];
    const emailToRow = new Map();
    const seenContactIds = new Set();

    for (const m of rawRows) {
      try {
        const props = m?.properties || {};
        const vcard = m?.vCard || m?.vcard || "";
        const parsed = parseVCardBasic(vcard);
        const id = m?.id || "";
        const addressbookId = m?.parentId || m?.parentid || m?.parent_id || "";

        // Skip if we've already seen this contact ID (prevents duplicates)
        if (id && seenContactIds.has(id)) {
          log(`[TMDBG Tools] contacts_search: skipping duplicate contact_id='${id}'`);
          continue;
        }
        if (id) seenContactIds.add(id);

        // Extract contact information
        const displayName = (props.DisplayName || parsed.fn || "").trim();
        const firstName = (props.FirstName || parsed.firstName || "").trim();
        const lastName = (props.LastName || parsed.lastName || "").trim();
        const nickName = (props.NickName || parsed.nickName || "").trim();
        const combinedName = [firstName, lastName].filter(Boolean).join(" ").trim();
        const resolvedName = displayName || combinedName || nickName || "";

        const primaryEmail = (props.PrimaryEmail || parsed.preferredEmail || "").trim();
        const secondEmail = (props.SecondEmail || "").trim();
        const allEmailsRaw = [primaryEmail, secondEmail, ...parsed.emails].filter(Boolean);
        const allEmails = Array.from(new Set(allEmailsRaw.map((e) => String(e).trim())));

        if (allEmails.length === 0) {
          log(`[TMDBG Tools] contacts_search: skipping contact with no email (name='${resolvedName}', id='${id}')`);
          continue;
        }

        // Create candidate with all necessary data
        const candidate = {
          name: resolvedName,
          email: primaryEmail || allEmails[0], // Use primary email or first available
          primaryEmail: primaryEmail,
          emails: allEmails,
          id: id,
          addressbookId: addressbookId,
          firstName: firstName,
          lastName: lastName,
          nickName: nickName,
          props: props,
          parsed: parsed,
          rawRow: m
        };

        candidates.push(candidate);

        // Build email-to-row mapping for this candidate
        for (const email of allEmails) {
          const k = String(email).toLowerCase();
          if (!emailToRow.has(k)) {
            emailToRow.set(k, candidate);
          }
        }

      } catch (e) {
        log(`[TMDBG Tools] contacts_search: failed to process raw row: ${e}`, "warn");
      }
    }

    log(`[TMDBG Tools] contacts_search: processed ${candidates.length} unique candidates, emailToRow.size=${emailToRow.size}`);

    // Apply limit and sort by name length (prefer longer names)
    const sortedCandidates = candidates
      .sort((a, b) => (b.name || "").length - (a.name || "").length)
      .slice(0, limit);

    const lines = sortedCandidates.map((candidate) => {
      const name = candidate.name || "(No name)";
      const selectedEmail = candidate.email || "";
      const primaryResolved = candidate.primaryEmail || selectedEmail || "";
      const others = candidate.emails.filter((e) => e.toLowerCase() !== primaryResolved.toLowerCase());

      log(`[TMDBG Tools] contacts_search: processing '${name}' id='${candidate.id}' email='${selectedEmail}' addressbookId='${candidate.addressbookId}'`);

      return [
        `name: ${name}`,
        `email: ${selectedEmail}`,
        `primary: ${primaryResolved}`,
        `other_emails: ${others.join(", ")}`,
        `first_name: ${candidate.firstName}`,
        `last_name: ${candidate.lastName}`,
        `nick_name: ${candidate.nickName}`,
        `contact_id: ${candidate.id}`,
        `addressbook_id: ${candidate.addressbookId}`,
      ].join("\n");
    });

    const out = lines.join("\n-----\n");
    log(`[TMDBG Tools] contacts_search: returning ${sortedCandidates.length} entries with IDs`);
    
    // Add a note about contact editability if we have contacts from different address books
    const addressbookIds = [...new Set(sortedCandidates.map(c => c.addressbookId).filter(Boolean))];
    if (addressbookIds.length > 1) {
      log(`[TMDBG Tools] contacts_search: contacts found in ${addressbookIds.length} different address books - only contacts in the default book can be edited/deleted`);
    }
    
    return out;
  } catch (e) {
    log(`[TMDBG Tools] contacts_search failed: ${e}`, "error");
    return { error: String(e || "unknown error in contacts_search") };
  }
}



