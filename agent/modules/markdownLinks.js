/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// agent/modules/markdownLinks.js
// Links in converted HTML text: stripHtml writes each as Markdown [label](address),
// and display surfaces unwrap them back to the label. No dependencies, so content
// and background modules alike can import it.

// Link text rules, the same as iOS `EmailFilter.htmlToPlainText` (tabmail-ios #100), so
// the agent and search read a link identically on both platforms.
const LINK_EDGE_WHITESPACE = /^\p{White_Space}+|\p{White_Space}+$/gu;
// A label splits on whitespace CHARACTERS (grapheme clusters), as Swift's
// `split(whereSeparator: { $0.isWhitespace })` does: a cluster is whitespace when its
// first code point is, so a space carrying a combining or format mark drops with it.
const LINK_LABEL_GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const LINK_LABEL_WHITESPACE_CLUSTER = /^\p{White_Space}/u;
const LINK_LABEL_ESCAPED = new Set(["\\", "[", "]", "`", "*", "_", "<", ">", "~"]);
const LINK_ADDRESS_ENCODED = /^[\p{Cc}\p{Cf}\p{White_Space}]$/u;
const LINK_ADDRESS_ESCAPED = new Set(["\\", "(", ")", "<", ">", ";"]);

/**
 * Writes a link as Markdown `[label](address)`. The label's whitespace collapses
 * to single spaces, Markdown punctuation in it is backslash-escaped and `&`
 * becomes `&amp;`. In the address, control, format and whitespace characters are
 * percent-encoded as UTF-8 and `\ ( ) < > ;` are backslash-escaped (an escaped
 * semicolon stops a Markdown reader decoding an entity twice).
 * `unwrapMarkdownLinks` reverses the label escapes for display. An empty or
 * missing href (after trimming) leaves the label as it is.
 * @param {string} labelText - The link's text, as converted.
 * @param {string|null|undefined} rawHref - The href attribute, entities decoded.
 * @returns {string}
 */
export function markdownLink(labelText, rawHref) {
    const href = String(rawHref || "").replace(LINK_EDGE_WHITESPACE, "");
    if (!href) return labelText;
    const words = [];
    let word = "";
    for (const { segment } of LINK_LABEL_GRAPHEMES.segment(String(labelText))) {
        if (!LINK_LABEL_WHITESPACE_CLUSTER.test(segment)) {
            word += segment;
        } else if (word) {
            words.push(word);
            word = "";
        }
    }
    if (word) words.push(word);
    const label = words.join(" ");
    let escapedLabel = "";
    for (const ch of label) {
        if (ch === "&") {
            escapedLabel += "&amp;";
        } else {
            escapedLabel += LINK_LABEL_ESCAPED.has(ch) ? `\\${ch}` : ch;
        }
    }
    let address = "";
    for (const ch of href) {
        if (LINK_ADDRESS_ENCODED.test(ch)) {
            address += encodeURIComponent(ch);
        } else {
            address += LINK_ADDRESS_ESCAPED.has(ch) ? `\\${ch}` : ch;
        }
    }
    return `[${escapedLabel}](${address})`;
}

function isLineTerminatorCode(v) {
    return v === 0x0A || v === 0x0B || v === 0x0C || v === 0x0D || v === 0x85 || v === 0x2028 || v === 0x2029;
}

const WHITE_SPACE_CHAR = /^\p{White_Space}$/u;

/**
 * Renders Markdown links as their bare label, for DISPLAY only (card snippets,
 * thread bubbles): `[label](address)` becomes `label`, with the escapes
 * `markdownLink` adds reversed. Search and the agent keep the full link.
 *
 * The grammar is iOS `EmailFilter.unwrapMarkdownLinks`: a link sits on one line;
 * a label is a run of `\x` escape pairs (`x` not a line terminator) and
 * characters other than `[`, `]`, `\` and line terminators, closed by `]`; `(`
 * follows immediately; an address is a run of escape pairs and characters other
 * than `)`, `\` and whitespace, closed by `)`. Scanning is leftmost, greedy
 * without backtracking, and resumes after a link. Anything else (a bare
 * `[note]`, an unterminated `[label](...`, `[x] (...)`, a dangling `\`) is
 * copied through unchanged.
 *
 * Linear in the input: two right-to-left passes record where a label or address
 * scan starting at each position closes, so each `[` is decided in O(1). A regex
 * over the same grammar is quadratic on a run of unclosed `[](`.
 * @param {string} text
 * @returns {string}
 */
export function unwrapMarkdownLinks(text) {
    const s = Array.from(String(text || ""));
    const n = s.length;
    const fail = -1;
    // labelEnd[j]: index of the `]` a label scan starting at j stops on, or fail.
    // addressEnd[j]: index of the `)` an address scan starting at j stops on, or fail.
    const labelEnd = new Int32Array(n + 2).fill(fail);
    const addressEnd = new Int32Array(n + 2).fill(fail);
    for (let j = n - 1; j >= 0; j--) {
        const ch = s[j];
        if (ch === "\\") {
            // An escape pair needs a following non-line-terminator; a dangling `\` fails both scans.
            if (j + 1 < n && !isLineTerminatorCode(s[j + 1].codePointAt(0))) {
                labelEnd[j] = labelEnd[j + 2];
                addressEnd[j] = addressEnd[j + 2];
            }
        } else {
            labelEnd[j] = ch === "]" ? j : (ch === "[" || isLineTerminatorCode(ch.codePointAt(0))) ? fail : labelEnd[j + 1];
            addressEnd[j] = ch === ")" ? j : WHITE_SPACE_CHAR.test(ch) ? fail : addressEnd[j + 1];
        }
    }
    let out = "";
    let c = 0;
    while (c < n) {
        if (s[c] === "[") {
            const k = labelEnd[c + 1];
            if (k !== fail && k + 1 < n && s[k + 1] === "(" && addressEnd[k + 2] !== fail) {
                // A link: emit the label with its escapes reversed, skip the address.
                let label = "";
                for (let i = c + 1; i < k; i++) {
                    if (s[i] === "\\" && i + 1 < k) i++;
                    label += s[i];
                }
                out += label.replaceAll("&amp;", "&");
                c = addressEnd[k + 2] + 1;
                continue;
            }
        }
        out += s[c];
        c++;
    }
    return out;
}
