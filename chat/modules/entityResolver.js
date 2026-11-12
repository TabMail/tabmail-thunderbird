/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// entityResolver.js – Shared helpers to resolve contact, event, and email details
// Thunderbird 145, MV3

import { log, resolveUniqueMessageKey } from "../../agent/modules/utils.js";

/**
 * Resolve contact details from a contact ID
 * @param {string} contactId - The contact ID (not compound)
 * @returns {Promise<{name: string, email: string, emails: string[]} | null>}
 */
export async function resolveContactDetails(contactId) {
  try {
    if (!browser.addressBooks?.contacts?.get) {
      log(`[EntityResolver] addressBooks.contacts.get API not available`);
      return null;
    }
    
    const contact = await browser.addressBooks.contacts.get(contactId);
    if (!contact) {
      return null;
    }
    
    // Parse vCard to extract name and emails (same as markdown.js)
    const vCard = contact.vCard || contact.vcard || "";
    const nameMatch = vCard.match(/FN:(.+)/);
    
    // Extract all email addresses
    const emailMatches = vCard.match(/EMAIL[^:]*:([^\r\n]+)/g) || [];
    const emails = emailMatches.map(match => {
      const email = match.split(':')[1]?.trim();
      return email;
    }).filter(Boolean);
    
    const name = nameMatch ? nameMatch[1].trim() : "";
    const primaryEmail = emails[0] || "";
    
    // If vCard parsing fails, try properties as fallback
    if (!name && contact.properties) {
      const props = contact.properties;
      const displayName = props.DisplayName || "";
      const firstName = props.FirstName || "";
      const lastName = props.LastName || "";
      const combinedName = [firstName, lastName].filter(Boolean).join(" ").trim();
      const fallbackName = displayName || combinedName || "";
      const fallbackEmail = props.PrimaryEmail || "";
      
      return {
        name: fallbackName || "(No name)",
        email: fallbackEmail || primaryEmail,
        emails: fallbackEmail ? [fallbackEmail, ...emails.filter(e => e !== fallbackEmail)] : emails,
      };
    }
    
    return {
      name: name || "(No name)",
      email: primaryEmail,
      emails: emails,
    };
  } catch (e) {
    log(`[EntityResolver] Failed to resolve contact ${contactId}: ${e}`, "warn");
    return null;
  }
}

/**
 * Resolve calendar event details from an event ID
 * @param {string} eventId - The event ID (not compound)
 * `start` and `end` are epoch milliseconds, passed through from tmCalendar ("" when the event has none).
 * An all-day event (`allDay`) is a date with no zone: its `start` is UTC midnight of its day, which names
 * the previous day west of UTC, so its days are `startDay`/`endDay` ("YYYY-MM-DD", the end exclusive),
 * passed through from tmCalendar ("" for a timed event). `startDate` (the @-mention list's date, in the
 * user's locale) names an all-day event's `startDay` and a timed event's local day.
 * @returns {Promise<{title: string, startDate: string, location: string, start: number|"", end: number|"", allDay: boolean, startDay: string, endDay: string, attendees: number, attendeeList: Array, organizer: string, ok: boolean} | null>}
 */
export async function resolveEventDetails(eventId) {
  try {
    if (!browser.tmCalendar?.getCalendarEventDetails) {
      log(`[EntityResolver] tmCalendar.getCalendarEventDetails API not available`);
      return null;
    }
    
    const event = await browser.tmCalendar.getCalendarEventDetails(eventId);
    if (!event || !event.ok) {
      log(`[EntityResolver] Event ${eventId} not found or not ok: ${event ? `ok=${event.ok}` : "null"}`);
      return null;
    }
    
    const title = event.title || "";
    // `startDate` is what the @-mention list shows, in the user's locale. An all-day event's
    // day comes from its date digits (`startDay`), never its instant: UTC midnight read in the
    // user's zone names the previous day west of UTC. A timed event's day is its local day.
    let shownStart = event.start ? new Date(event.start) : null;
    let shownZone;
    if (event.isAllDay) {
      const [y, m, d] = event.startDay.split("-").map(Number);
      shownStart = new Date(Date.UTC(y, m - 1, d));
      shownZone = "UTC";
    }
    const startDate = shownStart ? shownStart.toLocaleDateString(undefined, { timeZone: shownZone }) : "";
    const location = event.location || "";
    
    return {
      title: title || "(No title)",
      startDate: startDate,
      location: location,
      // Full details for tooltip rendering
      start: event.start || "",
      end: event.end || "",
      allDay: !!event.isAllDay,
      startDay: event.startDay || "",
      endDay: event.endDay || "",
      attendees: event.attendees || 0,
      attendeeList: event.attendeeList || [],
      organizer: event.organizer || "",
      ok: true,
    };
  } catch (e) {
    log(`[EntityResolver] Failed to resolve event ${eventId}: ${e}`, "warn");
    return null;
  }
}

/**
 * Resolve email subject from a unique_id
 * @param {string} uniqueId - The email unique_id (accountId:folderPath:headerID format)
 * @returns {Promise<{subject: string, from: string} | null>}
 */
export async function resolveEmailSubject(uniqueId) {
  try {
    const resolved = await resolveUniqueMessageKey(uniqueId);
    if (!resolved) {
      log(`[EntityResolver] Failed to resolve unique_id to one live message: ${uniqueId}`);
      return null;
    }
    const internalId = resolved.weID;
    
    // Get message header
    const header = await browser.messages.get(internalId);
    if (!header) {
      log(`[EntityResolver] Failed to get message header for ${internalId}`);
      return null;
    }
    
    return {
      subject: header.subject || "(No subject)",
      from: header.author || "",
    };
  } catch (e) {
    log(`[EntityResolver] Failed to resolve email ${uniqueId}: ${e}`, "warn");
    return null;
  }
}
