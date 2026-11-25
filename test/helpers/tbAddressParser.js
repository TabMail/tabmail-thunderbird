/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Thunderbird's own address parsing, for tests.
//
// The add-on reads every address with browser.messengerUtilities.parseMailboxString,
// and Thunderbird hands it each From/To/Cc entry already parsed and re-quoted. This
// module runs the same steps with Thunderbird's JSMime (test/vendor/jsmime, see its
// README for the source and changeset), so tests feed the add-on what Thunderbird gives
// it and parse it as Thunderbird does:
// - tbEntries(raw): the entries browser.messages gives for a raw To or Cc header
//   (ExtensionMessages.sys.mjs, parseEncodedAddrHeader: parseEncodedHeaderW, then
//   makeMimeAddress for each mailbox with a name);
// - tbAuthor(raw): the author entry, the first From mailbox;
// - parseEncodedHeaderW(raw): MailServices.headerParser.parseEncodedHeaderW, which
//   the experiments call on a message header's raw author;
// - parseMailboxString(entry): messengerUtilities.parseMailboxString
//   (ext-messengerUtilities.js: headerParser.parseDecodedHeader, groups flattened).
// The steps follow MimeJSComponents.sys.mjs (fixArray, makeMimeHeader) at the same
// changeset.

import { jsmime } from "../vendor/jsmime/jsmime.mjs";

// fixArray(addresses, false): group members flattened, NUL characters removed.
function mailboxes(parsed) {
  const out = [];
  for (const element of parsed) {
    for (const m of "group" in element ? element.group : [element]) {
      out.push({
        name: String(m.name ?? "").replace(/\x00/g, ""),
        email: String(m.email ?? "").replace(/\x00/g, ""),
      });
    }
  }
  return out;
}

// MimeAddressParser.makeMimeAddress: one mailbox emitted on one line, names quoted
// and escaped as the header emitter does, no RFC 2047 encoding.
function makeMimeAddress(name, email) {
  let value = "";
  const handler = {
    deliverData(str) {
      value += str;
    },
    deliverEOF() {},
  };
  const emitter = new jsmime.headeremitter.makeStreamingEmitter(handler, {
    softMargin: 900,
    hardMargin: 900,
    useASCII: false,
  });
  emitter.addAddresses([{ name, email: email ? email.trim() : email }]);
  emitter.finish(true);
  return value.replace(/\r\n( |$)/g, "");
}

/** MailServices.headerParser.parseEncodedHeaderW(raw): a raw header's mailboxes, groups flattened. */
export function parseEncodedHeaderW(rawHeader) {
  return mailboxes(jsmime.headerparser.parseAddressingHeader(rawHeader || "", true));
}

/** The entries browser.messages gives for a raw address header (recipients, ccList). */
export function tbEntries(rawHeader) {
  return parseEncodedHeaderW(rawHeader).map(({ name, email }) => (name ? makeMimeAddress(name, email) : email));
}

/** The `author` browser.messages gives for a raw From header: its first mailbox. */
export function tbAuthor(rawHeader) {
  return tbEntries(rawHeader).shift() || "";
}

/** browser.messengerUtilities.parseMailboxString(entry), without options. */
export async function parseMailboxString(entry) {
  return mailboxes(jsmime.headerparser.parseAddressingHeader(entry || "", false)).map(
    ({ name, email }) => ({ name: name || undefined, group: undefined, email: email || undefined })
  );
}

/** Adds messengerUtilities.parseMailboxString to a test's `browser` object. */
export function withTbAddressParser(browser = {}) {
  browser.messengerUtilities = { ...(browser.messengerUtilities || {}), parseMailboxString };
  return browser;
}
