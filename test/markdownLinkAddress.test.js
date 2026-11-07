/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A Markdown link in a chat reply is one anchor whose address is exactly the
// address written, whatever characters it holds, in a paragraph and in a
// table cell alike.

import { describe, it, expect, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: vi.fn((text) => (typeof text === 'string' ? text.normalize('NFKC') : text)),
}));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { debugMode: false, logFolder: 'logs' } }));
vi.mock('../chat/modules/entityResolver.js', () => ({
  resolveContactDetails: vi.fn(async () => null),
  resolveEventDetails: vi.fn(async () => null),
}));
vi.mock('../chat/modules/helpers.js', () => ({ getGenericTimezoneAbbr: vi.fn(() => 'PT') }));
vi.mock('../chat/modules/idTranslator.js', () => ({ processLLMResponseLLMtoTB: vi.fn((text) => text) }));

const { renderMarkdown, attachSpecialLinkListeners } = await import('../chat/modules/markdown.js');

const { window } = new JSDOM('');
const { document } = window;
const parse = html => {
  const body = document.createElement('body');
  body.innerHTML = html;
  return body;
};

// The anchors a link renders to, in a paragraph and in a table cell.
async function anchorsFor(address) {
  const link = `[docs](${address})`;
  const paragraph = parse(await renderMarkdown(`See ${link} now`));
  const table = parse(await renderMarkdown(`| A | B |\n| --- | --- |\n| See ${link} now | x |`));
  return [paragraph.querySelectorAll('a'), table.querySelectorAll('tbody td a')];
}

function expectOneLink(anchors, address) {
  expect(anchors, address).toHaveLength(1);
  const [a] = anchors;
  expect(a.getAttributeNames(), address).toEqual(['href', 'target', 'rel']);
  expect(a.getAttribute('href'), address).toBe(address);
  expect(a.getAttribute('target')).toBe('_blank');
  expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  expect(a.textContent).toBe('docs');
  expect(a.children).toHaveLength(0);
}

// Clicks the one external link in `html` once the chat's listeners are
// attached, and returns what was opened in the default browser.
async function clickLink(html) {
  const opened = [];
  globalThis.browser = { windows: { openDefaultBrowser: vi.fn(async url => { opened.push(url); }) } };
  globalThis.document = document;
  const container = parse(html);
  document.body.replaceChildren(container);
  attachSpecialLinkListeners(container);
  const click = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  container.querySelector('a').dispatchEvent(click);
  await Promise.resolve();
  delete globalThis.browser;
  delete globalThis.document;
  return { opened, prevented: click.defaultPrevented };
}

describe('an ordinary chat link renders and opens as it always has', () => {
  it('a normal https link renders the same markup and opens its address in the default browser', async () => {
    const address = 'https://example.com/docs/page-2?id=7#top';
    const html = await renderMarkdown(`Read [the docs](${address}) first`);
    expect(html).toBe(`<p>Read <a href="${address}" target="_blank" rel="noopener noreferrer">the docs</a> first</p>`);
    expect(await clickLink(html)).toEqual({ opened: [address], prevented: true });
  });

  it('a link whose address holds an ampersand and a quote opens exactly that address', async () => {
    const address = 'https://example.com/q?a=1&b="2"&amp;c';
    const html = await renderMarkdown(`Read [the docs](${address}) first`);
    expect(await clickLink(html)).toEqual({ opened: [address], prevented: true });
  });

  it('a normal https link in a table cell opens its address in the default browser', async () => {
    const address = 'https://example.com/table/row';
    const html = await renderMarkdown(`| A | B |\n| --- | --- |\n| [row](${address}) | x |`);
    expect(await clickLink(html)).toEqual({ opened: [address], prevented: true });
  });

  it.each([
    ['an already percent-encoded https address', 'https://example.com/%22%26%3C?a=1+2'],
    ['an http address', 'http://example.com/Path/Case?Q=1'],
  ])('%s renders as written and opens exactly that address', async (_label, address) => {
    const html = await renderMarkdown(`Read [the docs](${address}) first`);
    expect(html).toBe(`<p>Read <a href="${address}" target="_blank" rel="noopener noreferrer">the docs</a> first</p>`);
    expect(await clickLink(html)).toEqual({ opened: [address], prevented: true });
  });

  it('a mail link is left to Thunderbird, as before: nothing opens in the browser', async () => {
    const address = 'mailto:someone@example.com';
    const html = await renderMarkdown(`Write to [someone](${address})`);
    expect(html).toBe(`<p>Write to <a href="${address}" target="_blank" rel="noopener noreferrer">someone</a></p>`);
    expect(await clickLink(html)).toEqual({ opened: [], prevented: false });
  });
});

// Every block a link can sit in: the link markdown in place of LINK, and the
// element the anchor must be inside.
const BLOCKS = [
  ...[1, 2, 3, 4, 5, 6].map(level => [`a level ${level} heading`, `${'#'.repeat(level)} See LINK now`, `h${level}`]),
  ['an unordered list item', '- first\n- See LINK now', 'ul > li'],
  ['an ordered list item', '1. first\n2. See LINK now', 'ol > li'],
  ['a nested list item', '- outer\n  - See LINK now', 'ul ul li'],
  ['a nested ordered list item', '1. outer\n   1. See LINK now', 'ol ol li'],
  ['a blockquote', '> See LINK now', 'blockquote'],
  ['a reminder card', '[reminder] See LINK now', '[data-reminder-index]'],
  ['a table header', '| See LINK now | B |\n| --- | --- |\n| x | y |', 'thead th'],
];

describe('a chat link is the address written in every block it can sit in', () => {
  const addresses = [
    'https://example.com/a"b',
    'https://example.com/"data-x="yes',
    "https://example.com/it's",
    'https://example.com/q?a=1&b=2&amp;c&quot;d',
    'https://example.com/<b>x</b>',
    'https://example.com/%22%26%3C?a=1+2',
  ];

  it.each(BLOCKS)('%s', async (_label, markdown, inside) => {
    for (const address of addresses) {
      const body = parse(await renderMarkdown(markdown.replace('LINK', `[docs](${address})`)));
      const anchors = body.querySelectorAll('a');
      expectOneLink(anchors, address);
      expect(anchors[0].closest(inside), `${address} inside ${inside}`).not.toBeNull();
    }
  });

  it.each(BLOCKS)('a normal https link in %s opens its address in the default browser', async (_label, markdown) => {
    const address = 'https://example.com/docs/page-2?id=7#top';
    const html = await renderMarkdown(markdown.replace('LINK', `[docs](${address})`));
    expect(await clickLink(html)).toEqual({ opened: [address], prevented: true });
  });
});

describe('a chat link is one anchor with the address written', () => {
  it.each([
    ['a double quote', 'https://example.com/a"b'],
    ['a quote then attribute-like text', 'https://example.com/"data-x="yes'],
    ['a single quote', "https://example.com/it's"],
    ['an ampersand and a query', 'https://example.com/q?a=1&b=2&amp;c'],
    ['angle brackets', 'https://example.com/<b>x</b>'],
    ['a plain address', 'https://example.com/plain/path'],
    ['a mail address', 'mailto:someone@example.com?subject="hi"'],
  ])('%s', async (_label, address) => {
    for (const anchors of await anchorsFor(address)) expectOneLink(anchors, address);
  });

  it('seeded addresses of quote, bracket, ampersand and equals pieces', async () => {
    const pieces = ['"', "'", '<', '>', '&', '=', 'a', '/', '?', '#', ';', 'amp', 'quot', 'x '.trim(), '"onclick="', '"style="'];
    let seed = 225673;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let n = 0; n < 300; n++) {
      const length = 1 + (next() % 10);
      const address = `https://example.com/${Array.from({ length }, () => pieces[next() % pieces.length]).join('')}`;
      for (const anchors of await anchorsFor(address)) expectOneLink(anchors, address);
    }
  });
});
