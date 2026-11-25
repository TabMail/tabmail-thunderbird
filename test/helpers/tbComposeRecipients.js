/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Thunderbird's compose window recipients, for tests.
//
// - tbHeaderParser(version): MailServices.headerParser's code as Thunderbird ships it, '145'
//   (the same file as 140.0esr) or '161' (the same makeFromDisplayAddress as 160). It is the
//   vendored MimeJSComponents.sys.mjs (test/vendor/mimejscomponents, see its README) run as it
//   is, with the vendored JSMime (test/vendor/jsmime, Thunderbird 161) for its imports for both
//   versions; Thunderbird 145's own JSMime reads every address these tests use the same way.
// The compose window steps follow Thunderbird 160's own code (addressingWidgetOverlay.js,
// composeWidgets.mjs, ExtensionMessages.sys.mjs); setAddressRowFromCompField, recipientAddPills
// (apart from completing an autocomplete match) and Recipients2CompFields are the same in 145:
// - pillsFromHeader(parser, header): the address pills native SetComposeDetails makes for a
//   field. The header's mailboxes are written out as display text (each mailbox's toString,
//   names unquoted), read back with makeFromDisplayAddress, one pill per address, each pill's
//   fullAddress being that address's toString;
// - headerFromPills(parser, pills): the field native GetComposeDetails gives for a row of pills;
// - composeApiList(parser, header, emailOnly): the recipient list the compose API gives for a
//   field (parseEncodedAddrHeader).

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { jsmime } from "../vendor/jsmime/jsmime.mjs";

// MimeParser.parseHeaderField (mimeParser.sys.mjs) for the address parse the parser's methods
// use; any other kind of parse fails, so a use this does not model is not answered wrongly.
const MimeParser = {
  HEADER_ADDRESS: 0x03,
  HEADER_OPTION_DECODE_2047: 0x20,
  HEADER_OPTION_ALLOW_RAW: 0x40,
  parseHeaderField(text, flags) {
    if (flags !== 0x03 && flags !== 0x23) throw new Error(`Unmodelled MimeParser flags: ${flags}`);
    return jsmime.headerparser.parseAddressingHeader(text, (flags & 0x20) !== 0);
  },
};

const parsers = new Map();

/** MailServices.headerParser of Thunderbird `version` ('145' or '161'). */
export function tbHeaderParser(version) {
  if (!parsers.has(version)) {
    const url = new URL(`../vendor/mimejscomponents/MimeJSComponents-${version}.sys.mjs`, import.meta.url);
    let source = readFileSync(url, "utf8");
    const imports = source.match(/^import \{ \w+ \} from "resource:\/\/\/modules\/\w+\.sys\.mjs";$/gm) || [];
    if (imports.length !== 2) throw new Error(`Unexpected imports in ${url.pathname}`);
    for (const line of imports) source = source.replace(line, "");
    source = source.replace(/^export /gm, "");
    const MimeAddressParser = runInNewContext(`${source}\n;MimeAddressParser;`, {
      jsmime,
      MimeParser,
      ChromeUtils: { generateQI: () => () => {} },
      Components: { Exception: message => new Error(message) },
      Cr: {},
    }, { filename: url.pathname });
    parsers.set(version, new MimeAddressParser());
  }
  return parsers.get(version);
}

/** The pills (their fullAddress) native SetComposeDetails makes for a field's header. */
export function pillsFromHeader(parser, header) {
  const text = parser.parseEncodedHeaderW(header).join(", ");
  return text.trim() ? parser.makeFromDisplayAddress(text).map(address => address.toString()) : [];
}

/** The field native GetComposeDetails gives for a row's pills (their fullAddress). */
export function headerFromPills(parser, pills) {
  return pills.map(fullAddress => {
    const { name, email } = parser.makeFromDisplayAddress(fullAddress)[0];
    return parser.makeMimeAddress(name, email);
  }).join(",");
}

/** The compose API's recipient list for a field (ExtensionMessages parseEncodedAddrHeader). */
export function composeApiList(parser, header, emailOnly = false) {
  return parser.parseEncodedHeaderW(header).map(mailbox =>
    emailOnly || !mailbox.name ? mailbox.email : parser.makeMimeAddress(mailbox.name, mailbox.email)
  );
}
