/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Thunderbird's own address parsing, for tests.
//
// The add-on reads every address from Thunderbird's own parse of the raw From, To and
// Cc headers (the tmHdr experiment's getAddressFields: headerParser.parseEncodedHeaderW
// over each raw header). This module runs the same steps with Thunderbird's JSMime
// (test/vendor/jsmime, see its README for the source and changeset):
// - parseEncodedHeaderW(raw): MailServices.headerParser.parseEncodedHeaderW;
// - tbAddressFields(raw): what tmHdr.getAddressFields returns for a message with raw
//   From, To and Cc headers;
// - tbMessages() / withTbAddressFields(browser, store): synthetic messages by id, with
//   tmHdr.getAddressFields reading them (an unknown id reads as a gone message);
// - tbEntries(raw), tbAuthor(raw): the strings browser.messages gives as recipients /
//   ccList and author (ExtensionMessages.sys.mjs, parseEncodedAddrHeader:
//   parseEncodedHeaderW, then makeMimeAddress for each mailbox with a name). The add-on
//   never parses them; tests put them on a message so that reading them instead of
//   Thunderbird's parse fails.
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

/** What tmHdr.getAddressFields returns for a message with these raw From, To and Cc headers. */
export function tbAddressFields({ from = "", to = "", cc = "" } = {}) {
  return {
    author: parseEncodedHeaderW(from),
    recipients: parseEncodedHeaderW(to),
    ccList: parseEncodedHeaderW(cc),
  };
}

/**
 * Synthetic messages by id. add({ from, to, cc }, extra) stores the raw headers and returns
 * the MessageHeader browser.messages would give for them (id, author, recipients, ccList,
 * plus `extra`); getAddressFields(ids) answers as the experiment does, null for an unknown id.
 */
export function tbMessages() {
  const raws = new Map();
  let nextId = 1;
  return {
    add(raw = {}, extra = {}) {
      const id = nextId++;
      raws.set(id, raw);
      return {
        id,
        author: tbAuthor(raw.from || ""),
        recipients: tbEntries(raw.to || ""),
        ccList: tbEntries(raw.cc || ""),
        ...extra,
      };
    },
    async getAddressFields(ids) {
      return ids.map((id) => (raws.has(id) ? tbAddressFields(raws.get(id)) : null));
    },
  };
}

/** Adds tmHdr.getAddressFields, reading `store` (tbMessages()), to a test's `browser` object. */
export function withTbAddressFields(browser = {}, store = tbMessages()) {
  browser.tmHdr = { ...(browser.tmHdr || {}), getAddressFields: (ids) => store.getAddressFields(ids) };
  return browser;
}
