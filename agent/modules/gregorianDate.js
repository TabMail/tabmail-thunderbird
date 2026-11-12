/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The one formatter for every date the add-on shows the assistant or writes.
//
// Thunderbird's JS default locale is its UI language, so a date formatted
// without a locale follows that language's calendar: a Thai Thunderbird prints
// 2026 as the Buddhist year 2569, a Persian one prints the Persian year 1405 in
// Persian digits. A date the assistant reads in another calendar can come back
// in its reply or in an event it creates or moves, a year off on the server.
// This prints English, Gregorian, Latin digits whatever the UI language.
// Dates only the user reads (settings pages, the message list) stay in their
// language. test/localeDateFence.test.js keeps user-locale formatting out of
// every other path.

/**
 * A date as `Intl.DateTimeFormat` prints it with `options`, in English, the
 * Gregorian calendar and Latin digits.
 * @param {Date} date
 * @param {Intl.DateTimeFormatOptions} options - the fields to print (and `timeZone`)
 * @returns {string}
 */
export function formatGregorianDate(date, options) {
  return new Intl.DateTimeFormat("en-US", { ...options, calendar: "gregory", numberingSystem: "latn" }).format(date);
}
