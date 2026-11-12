/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Makes `locale` the process's default locale for date formatting, as
// Thunderbird's UI language is in the add-on (a Thai Thunderbird reports
// `th`, Buddhist calendar). Node's default locale is fixed at start-up, so the
// date formatters are wrapped: a call that names no locale (no argument,
// `undefined` or `[]`) gets `locale`; a call that names one is passed through.
// Returns a function that restores the originals.

const isDefault = (locales) => locales === undefined || (Array.isArray(locales) && locales.length === 0);

export function stubDefaultLocale(locale) {
  const original = {
    toLocaleString: Date.prototype.toLocaleString,
    toLocaleDateString: Date.prototype.toLocaleDateString,
    toLocaleTimeString: Date.prototype.toLocaleTimeString,
    DateTimeFormat: Intl.DateTimeFormat,
  };
  for (const name of ['toLocaleString', 'toLocaleDateString', 'toLocaleTimeString']) {
    const fn = original[name];
    Date.prototype[name] = function (locales, options) {
      return fn.call(this, isDefault(locales) ? locale : locales, options);
    };
  }
  const OriginalFormat = original.DateTimeFormat;
  function DateTimeFormat(locales, options) {
    return new OriginalFormat(isDefault(locales) ? locale : locales, options);
  }
  DateTimeFormat.prototype = OriginalFormat.prototype;
  DateTimeFormat.supportedLocalesOf = OriginalFormat.supportedLocalesOf.bind(OriginalFormat);
  Intl.DateTimeFormat = DateTimeFormat;
  return () => {
    Date.prototype.toLocaleString = original.toLocaleString;
    Date.prototype.toLocaleDateString = original.toLocaleDateString;
    Date.prototype.toLocaleTimeString = original.toLocaleTimeString;
    Intl.DateTimeFormat = original.DateTimeFormat;
  };
}
