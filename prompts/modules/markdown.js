/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * How the prompts page reads a stored text, and the one-line changes it makes to it. The page keeps no
 * text of its own: each action takes the stored text, changes exactly the line or the section the user
 * acted on, and every other line stays as it is.
 */

import { headerOf, INSTRUCTIONS_END, lines as linesOf, parse, SECTION_HEADERS } from "../../agent/modules/bullets.js";

/** The item a non-empty line is, as the store reads it (DS-PARSE): its "- " dropped, trimmed. */
function itemText(line) {
    return parse("kb", line).bullets[0]?.text;
}

/**
 * The sections the page shows for `content`, `field`'s stored text, each
 * { key, title, copy, header, items: [{ line, text }] }: `header` is the index of its header line (-1 for
 * the knowledge base, which is one section with no header) and each item is a non-empty line of it, by
 * index. A section starts at one of the field's own headers, read as the store reads them (`headerOf`),
 * and runs to the next one or to a line that is exactly the END marker, from which on the text is the
 * field's footer. Any other line in a section, one holding a marker included, is an item. The same
 * section can be shown twice (R26: after a rule holding the END text, the store's footer holds sections
 * of its own); `copy` counts them. Lines are split as the store splits them (R2); the edits below join
 * them with "\n", as the store renders.
 */
export function pageSections(field, content) {
    const lines = linesOf(content || "");
    if (field === "kb") {
        return [{ key: "", title: "", copy: 0, header: -1, items: itemsOf(lines, 0, lines.length) }];
    }
    const sections = [];
    for (let index = 0; index < lines.length; index += 1) {
        if (sections.length > 0 && lines[index].trim() === INSTRUCTIONS_END) break;
        const key = headerOf(field, lines[index]);
        if (key === undefined) {
            if (sections.length > 0) {
                const text = itemText(lines[index]);
                if (text !== undefined) sections.at(-1).items.push({ line: index, text });
            }
            continue;
        }
        const title = SECTION_HEADERS[field].find(([k]) => k === key)[1];
        const copy = sections.filter((section) => section.key === key).length;
        sections.push({ key, title, copy, header: index, items: [] });
    }
    return sections;
}

function itemsOf(lines, from, to) {
    const items = [];
    for (let index = from; index < to; index += 1) {
        const text = itemText(lines[index]);
        if (text !== undefined) items.push({ line: index, text });
    }
    return items;
}

function sectionAt(field, content, where) {
    return pageSections(field, content).find((section) => section.key === where.key && section.copy === where.copy);
}

/**
 * `content` without the item the user removed: the first of the section `where` ({ key, copy }) with
 * `where.text`. Lines of one section copy with the same item text differ only by their "- " or spaces,
 * so which of them goes is not seen. Null when the section no longer has it (it was removed meanwhile).
 */
export function removeItem(field, content, where) {
    const section = sectionAt(field, content, where);
    if (!section) return null;
    const item = section.items.find((it) => it.text === where.text);
    if (!item) return null;
    const lines = linesOf(content);
    lines.splice(item.line, 1);
    return lines.join("\n");
}

/** Where a new line of the section goes: after its last item, else right after its header. */
function insertAt(section) {
    return section.items.length > 0 ? section.items.at(-1).line + 1 : section.header + 1;
}

/** `content` with `lines` added as the last items of the section `where`; null when it is gone. */
export function addItems(field, content, where, added) {
    const section = sectionAt(field, content, where);
    if (!section) return null;
    const lines = content === "" ? [] : linesOf(content);
    lines.splice(insertAt(section), 0, ...added.map((text) => `- ${text}`));
    return lines.join("\n");
}

/** `content` with every item of the section `where` replaced by `replacement` (texts); null when the
 * section is gone. */
export function replaceItems(field, content, where, replacement) {
    const section = sectionAt(field, content, where);
    if (!section) return null;
    const lines = linesOf(content);
    for (const item of [...section.items].reverse()) lines.splice(item.line, 1);
    const at = section.items.length > 0 ? section.items[0].line : section.header + 1;
    lines.splice(at, 0, ...replacement.map((text) => `- ${text}`));
    return lines.join("\n");
}
