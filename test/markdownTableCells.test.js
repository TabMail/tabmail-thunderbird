/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A chat reply's Markdown table cell renders its text as the rest of the
// reply does: tags written in the text show as text, and bold, italic, code
// and links come out as they do in a paragraph. Each case renders the same
// text once in a table cell and once as a paragraph and compares the two.

import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((text) => (typeof text === 'string' ? text.normalize('NFKC') : text)),
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugMode: false, logFolder: 'logs' } }));
vi.mock('../chat/modules/entityResolver.js', () => ({
  resolveContactDetails: vi.fn(async () => ({ name: 'Sam *Example*', email: 'sam@example.com', emails: ['sam@example.com'] })),
  resolveEventDetails: vi.fn(async () => null),
}));
vi.mock('../chat/modules/helpers.js', () => ({ getGenericTimezoneAbbr: vi.fn(() => 'PT') }));
vi.mock('../chat/modules/idTranslator.js', () => ({ processLLMResponseLLMtoTB: vi.fn((text) => text) }));

const { renderMarkdown } = await import('../chat/modules/markdown.js');

const { document } = new JSDOM('').window;
const parse = html => {
  const body = document.createElement('body');
  body.innerHTML = html;
  return body;
};

// The text rendered in a table's one body cell, and as a paragraph.
async function cellAndParagraph(text) {
  const table = parse(await renderMarkdown(`| Header | Other |\n| --- | --- |\n| ${text} | x |`));
  const cells = table.querySelectorAll('tbody td');
  const paragraph = parse(await renderMarkdown(text)).querySelector('p');
  expect(cells).toHaveLength(2);
  expect(paragraph).not.toBeNull();
  return { cell: cells[0], paragraph };
}

describe('a table cell renders its text as the rest of the reply does', () => {
  it.each([
    ['an image tag', 'Look <img src="https://example.com/p.png"> here'],
    ['a frame', 'See <iframe src="https://example.com/"></iframe> below'],
    ['an anchor with attributes', 'Go <a href="https://example.com/" title="t">there</a> now'],
    ['formatting tags', 'Plain <b>bold</b> and <i>italic</i>'],
    ['a closing tag alone', 'Ends with </td></tr></table> here'],
    ['angle brackets and quotes', 'a < b > c "double" \'single\''],
  ])('%s shows as the text written', async (_label, text) => {
    const { cell, paragraph } = await cellAndParagraph(text);
    expect(cell.children).toHaveLength(0);
    expect(cell.textContent).toBe(text);
    expect(cell.innerHTML).toBe(paragraph.innerHTML);
  });

  it('code spans keep their asterisks, as in a paragraph', async () => {
    const { cell, paragraph } = await cellAndParagraph('`*.txt` or `*.md`');
    expect([...cell.querySelectorAll('code')].map(c => c.textContent)).toEqual(['*.txt', '*.md']);
    expect(cell.querySelector('em')).toBeNull();
    expect(cell.innerHTML).toBe(paragraph.innerHTML);
  });

  it('a link keeps its address, as in a paragraph', async () => {
    const { cell, paragraph } = await cellAndParagraph('[docs](https://example.com/a*b*c) and *more*');
    const links = cell.querySelectorAll('a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('https://example.com/a*b*c');
    expect(links[0].textContent).toBe('docs');
    expect(cell.querySelector('em').textContent).toBe('more');
    expect(cell.innerHTML).toBe(paragraph.innerHTML);
  });

  it('bold, italic and code come out as in a paragraph', async () => {
    const { cell, paragraph } = await cellAndParagraph('**Bold** with `code` and *slant*');
    expect(cell.querySelector('strong').textContent).toBe('Bold');
    expect(cell.querySelector('code').textContent).toBe('code');
    expect(cell.querySelector('em').textContent).toBe('slant');
    expect(cell.innerHTML).toBe(paragraph.innerHTML);
  });

  it('a link to a contact comes out as in a paragraph', async () => {
    const { cell, paragraph } = await cellAndParagraph('Ask [Contact](42) and *note*');
    const links = cell.querySelectorAll('a.tm-contact-link');
    expect(links).toHaveLength(1);
    expect(links[0].textContent).toContain('Sam *Example*');
    expect(cell.querySelector('em').textContent).toBe('note');
    expect(cell.innerHTML).toBe(paragraph.innerHTML);
  });

  it('a line break and character references still render in a cell', async () => {
    const table = parse(await renderMarkdown('| A |  B |\n| --- | --- |\n| one<br>two | a &lt;b&gt; &amp; c |'));
    const [breakCell, refCell] = table.querySelectorAll('tbody td');
    expect([...breakCell.childNodes].map(n => n.nodeName)).toEqual(['#text', 'BR', '#text']);
    expect(breakCell.textContent).toBe('onetwo');
    expect(refCell.children).toHaveLength(0);
    expect(refCell.textContent).toBe('a <b> & c');
  });

  it('seeded texts of tag, quote, emphasis, code and link pieces render in a cell as in a paragraph', async () => {
    const pieces = ['<', '>', '</', '/>', 'img', 'src', '=', '"', "'", ' ', '*', '**', '`', '&', 'a', 'x', '[x](https://example.com/q)', '<a href="https://example.com/">'];
    let seed = 158153;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 400; n++) {
      const length = 1 + (next() % 12);
      const text = `x ${Array.from({ length }, () => pieces[next() % pieces.length]).join('')} x`;
      const { cell, paragraph } = await cellAndParagraph(text);
      expect(cell.innerHTML, text).toBe(paragraph.innerHTML);
      for (const element of cell.querySelectorAll('*')) {
        expect(['STRONG', 'EM', 'CODE', 'A'], text).toContain(element.nodeName);
        if (element.nodeName === 'A') expect(element.getAttribute('href'), text).toBe('https://example.com/q');
      }
    }
  });
});
