/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// What a calendar write's guest notice (the bridge's `invitations`: null when
// the event has no guests, { ok: true } once Thunderbird took the notice,
// { ok: false, error } when it could not) means for the user and for the
// assistant. Guests are always notified (#423); a notice that failed after a
// saved change is said plainly, so the assistant never reports the guests as
// told when they were not.

/** The line for the chat bubble, or "" when there are no guests. */
export function guestNoticeBubbleText(invitations) {
  if (!invitations) return "";
  if (invitations.ok === false) {
    return `Saved, but the guests could not be notified (${invitations.error || "unknown error"}).`;
  }
  return "The guests' notice was handed to Thunderbird to send.";
}

/** The sentence for the tool result the assistant reads, or "" when there are no guests. */
export function guestNoticeResultText(invitations) {
  if (!invitations) return "";
  if (invitations.ok === false) {
    return `The change was saved, but the guests could NOT be notified: ${invitations.error || "unknown error"}. Tell the user the guests have not been told of this change.`;
  }
  return "The guests' notice was handed to Thunderbird to send.";
}
