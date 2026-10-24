/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// markdownLinks.test.js — HTML links keep their address in converted text (#162),
// written as iOS writes them (tabmail-ios #100), and display surfaces show the label.

import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({ getAndClearThink: vi.fn(() => null) }));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

const { markdownLink, unwrapMarkdownLinks } = await import('../agent/modules/markdownLinks.js');
const { stripHtml, extractUserWrittenContent } = await import('../agent/modules/utils.js');
const { extractPlainText } = await import('../fts/bodyExtract.js');

let savedNode;
beforeAll(() => {
  const { window } = new JSDOM('');
  savedNode = globalThis.Node;
  globalThis.Node = window.Node;
  globalThis.DOMParser = window.DOMParser;
});
afterAll(() => {
  globalThis.Node = savedNode;
  delete globalThis.DOMParser;
});

describe('stripHtml writes a link as [label](address)', () => {
  it('keeps the address of a link inside text', () => {
    expect(stripHtml('<p>Read <a href="https://example.com/x">the post</a> today.</p>'))
      .toBe('Read [the post](https://example.com/x) today.');
  });

  it('collapses whitespace in the label, a no-break space and a block inside it included', () => {
    expect(stripHtml('<a href="https://example.com/a">  one\n\ttwo&nbsp;&nbsp;three <div>four</div> </a>'))
      .toBe('[one two three four](https://example.com/a)');
  });

  it('escapes Markdown punctuation in the label and writes & as &amp;', () => {
    expect(stripHtml('<a href="https://example.com/a">a\\b [c] `d` *e* _f_ &lt;g&gt; ~h~ i&amp;j</a>'))
      .toBe('[a\\\\b \\[c\\] \\`d\\` \\*e\\* \\_f\\_ \\<g\\> \\~h\\~ i&amp;j](https://example.com/a)');
  });

  it('percent-encodes control, format and whitespace characters in the address and escapes \\ ( ) < > ;', () => {
    const href = 'https://example.com/a b\tc&#x200B;d&#x7F;e(f)g<h>i;j\\k&amp;l/é';
    expect(stripHtml(`<a href="${href}">x</a>`))
      .toBe('[x](https://example.com/a%20b%09c%E2%80%8Bd%7Fe\\(f\\)g\\<h\\>i\\;j\\\\k&l/é)');
  });

  it('trims the address before writing it', () => {
    expect(stripHtml('<a href="\n  https://example.com/a&#xA0; ">x</a>')).toBe('[x](https://example.com/a)');
  });

  it('leaves the label alone when the href is missing, empty or only whitespace', () => {
    expect(stripHtml('<p>a <a>one</a> <a href="">two</a> <a href=" &#9; ">three</a> <a name="x">four</a></p>'))
      .toBe('a one two three four');
  });

  it('keeps the address of a link with no text, such as an image link', () => {
    expect(stripHtml('<a href="https://example.com/t"><img src="cid:logo@example.com"></a><p>Hello</p>'))
      .toBe('[](https://example.com/t)Hello');
  });

  it('drops a hidden link with its address', () => {
    expect(stripHtml('<p>Hi<a style="display:none" href="https://example.com/hidden">secret</a></p>')).toBe('Hi');
    expect(stripHtml('<p>Hi<span style="display: none"><a href="https://example.com/hidden">x</a></span></p>')).toBe('Hi');
  });

  it('writes each of several links, including a mailto address', () => {
    expect(stripHtml('<a href="mailto:someone@example.com">someone@example.com</a> or <a href="https://example.com/">site</a>'))
      .toBe('[someone@example.com](mailto:someone@example.com) or [site](https://example.com/)');
  });

  it('keeps a quote attribution on one line, so quote detection still reads it', () => {
    const html = '<div>Thanks</div><div>On Mon, Bob &lt;<a href="mailto:bob@example.com">bob@example.com</a>&gt; wrote:</div>';
    expect(stripHtml(html)).toBe('Thanks\nOn Mon, Bob <[bob@example.com](mailto:bob@example.com)> wrote:');
  });

  it('writes links in the user-written content the agent reads', () => {
    expect(extractUserWrittenContent('<p>See <a href="https://example.com/doc">the doc</a></p>', 'text/html'))
      .toBe('See [the doc](https://example.com/doc)');
  });

  it('gives search the address through the FTS body extractor', async () => {
    const full = { parts: [
      { contentType: 'text/plain', body: 'See the doc' },
      { contentType: 'text/html', body: '<p>See <a href="https://example.com/doc">the doc</a></p>' },
    ] };
    expect(await extractPlainText(full, 1)).toBe('See [the doc](https://example.com/doc)');
  });
});

describe('markdownLink', () => {
  it('returns the label unchanged when the href trims to nothing', () => {
    expect(markdownLink('  a  b ', null)).toBe('  a  b ');
    expect(markdownLink('a', undefined)).toBe('a');
    expect(markdownLink('a', '\u00A0\u2028 ')).toBe('a');
  });

  it('splits the label on whitespace characters, a space carrying a mark included, as iOS does', () => {
    expect(markdownLink('a \u{E0041}b\u3000\u200Cc', 'x')).toBe('[a b c](x)');
    expect(markdownLink('a\u0301 b', 'x')).toBe('[a\u0301 b](x)');
  });

  it('percent-encodes an astral format character as its UTF-8 bytes', () => {
    expect(markdownLink('a', 'https://example.com/\u{E0041}')).toBe('[a](https://example.com/%F3%A0%81%81)');
  });
});

describe('unwrapMarkdownLinks shows a link as its label', () => {
  it('reverses the label escapes and &amp;', () => {
    const html = '<a href="https://example.com/a(b)">a\\b [c] `d` *e* _f_ &lt;g&gt; ~h~ i&amp;j</a> rest';
    expect(unwrapMarkdownLinks(stripHtml(html))).toBe('a\\b [c] `d` *e* _f_ <g> ~h~ i&j rest');
  });

  it('round-trips every link of a converted body to the text the body shows', () => {
    const html = '<p>Hi <a href="https://example.com/1">one</a>, <a href="mailto:x@example.com">x@example.com</a>'
      + ' and <a href="https://example.com/a b;c">three</a>.</p><p><a href="https://example.com/t"><img src="x"></a>End</p>';
    expect(unwrapMarkdownLinks(stripHtml(html))).toBe('Hi one, x@example.com and three.\nEnd');
  });

  it('copies through text that is not a link', () => {
    for (const text of ['[note]', '[x] (y)', '[a](b c)', '[unterminated](https://example.com', 'a\\', '[a\\', '](x)', '[a]', '']) {
      expect(unwrapMarkdownLinks(text)).toBe(text);
    }
  });

  it('never matches a link across a line terminator', () => {
    for (const t of ['\n', '\u000B', '\u000C', '\r', '\u0085', '\u2028', '\u2029']) {
      expect(unwrapMarkdownLinks(`[a${t}b](x)`)).toBe(`[a${t}b](x)`);
      expect(unwrapMarkdownLinks(`[a\\${t}b](x)`)).toBe(`[a\\${t}b](x)`);
    }
  });

  it('stops an address at whitespace', () => {
    expect(unwrapMarkdownLinks('[a](x\u00A0y)')).toBe('[a](x\u00A0y)');
    expect(unwrapMarkdownLinks('[a](x\u3000y)')).toBe('[a](x\u3000y)');
  });

  it('takes an escaped bracket or parenthesis as part of the link', () => {
    expect(unwrapMarkdownLinks('[a\\]b](x\\)y) z')).toBe('a]b z');
  });

  it('scans leftmost and resumes after a link', () => {
    // The first address fails at the space; the link that starts inside it still unwraps.
    expect(unwrapMarkdownLinks('[a](x[b c](y)')).toBe('[a](xb c');
    expect(unwrapMarkdownLinks('[[a](x)')).toBe('[a');
    expect(unwrapMarkdownLinks('[a](x)[b](y)')).toBe('ab');
    expect(unwrapMarkdownLinks('[](x)[](y)Hello')).toBe('Hello');
  });

  it('keeps astral characters in a label', () => {
    expect(unwrapMarkdownLinks('[\u{1F600} \\*](x)')).toBe('\u{1F600} *');
  });

  it('leaves a long run of unclosed link openers unchanged', () => {
    const hostile = '[]('.repeat(10000) + '\\['.repeat(16000);
    expect(unwrapMarkdownLinks(hostile)).toBe(hostile);
  });

  it('treats a missing input as empty', () => {
    expect(unwrapMarkdownLinks(null)).toBe('');
    expect(unwrapMarkdownLinks(undefined)).toBe('');
  });
});
