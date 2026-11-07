/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The add-on's pages load images only from the add-on and frame nothing. The
// manifest's page policy says so, and nothing the pages use is blocked by it:
// every image their markup, styles and scripts name is one the add-on ships,
// and none of them makes a frame.
//
// The page code checked is what the pages actually load: each page's scripts
// and stylesheets, the background scripts, and every module they import. A
// static reading cannot see a source a script builds at run time from parts;
// the checks below catch every way the pages write one today, and each check
// is shown to catch the forms it is for.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const ORIGIN = 'moz-extension://addon/';
const skipped = new Set(['node_modules', 'test', '.git', 'coverage', 'web-ext-artifacts']);
const rel = path => relative(root, path);

function filesUnder(dir, extensions) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (skipped.has(name)) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path, extensions));
    else if (extensions.some(ext => name.endsWith(ext))) out.push(path);
  }
  return out;
}

// The policy's directives. The browser uses the first of a repeated
// directive, so a repeat is refused here rather than read either way.
function parsePolicy(policy) {
  const out = {};
  for (const part of policy.split(';')) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (!name) continue;
    if (Object.hasOwn(out, name.toLowerCase())) throw new Error(`directive repeated: ${name}`);
    out[name.toLowerCase()] = sources;
  }
  return out;
}

const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// Whether a reference, read from `base`, names something the add-on ships.
function insideAddOn(ref, base) {
  try {
    return new URL(ref, base).href.startsWith(ORIGIN);
  } catch {
    return false;
  }
}
const pageUrl = path => ORIGIN + rel(path);

// Each image candidate of a srcset.
const srcsetCandidates = value => String(value || '').split(',').map(c => c.trim().split(/\s+/)[0]).filter(Boolean);
const cssUrls = text => [
  ...[...text.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)].map(m => m[2]),
  ...[...text.matchAll(/@import\s+(['"])(.*?)\1/g)].map(m => m[2]),
];

// What a page's markup loads or would frame, read as the browser reads it:
// every reference against the page's base address.
function markupProblems(html, url) {
  const { document } = new JSDOM(html, { url }).window;
  const problems = [...document.querySelectorAll('iframe, frame, embed, object')].map(el => `a ${el.localName}`);
  const refs = [
    ...[...document.querySelectorAll('img')].flatMap(img => [img.getAttribute('src'), img.getAttribute('data-light-src'), img.getAttribute('data-dark-src'), ...srcsetCandidates(img.getAttribute('srcset'))]),
    ...[...document.querySelectorAll('picture source, img[srcset]')].flatMap(el => srcsetCandidates(el.getAttribute('srcset'))),
    ...[...document.querySelectorAll('input[type="image"]')].map(el => el.getAttribute('src')),
    ...[...document.querySelectorAll('video[poster]')].map(el => el.getAttribute('poster')),
    ...[...document.querySelectorAll('image, use')].flatMap(el => [el.getAttribute('href'), el.getAttribute('xlink:href')]),
    ...[...document.querySelectorAll('link[rel~="icon"], link[rel~="stylesheet"]')].map(link => link.getAttribute('href')),
    ...[...document.querySelectorAll('[style]')].flatMap(el => cssUrls(el.getAttribute('style'))),
    ...[...document.querySelectorAll('style')].flatMap(el => cssUrls(el.textContent)),
  ].filter(ref => ref !== null && ref !== undefined);
  for (const ref of refs) if (!insideAddOn(ref, document.baseURI)) problems.push(ref);
  return problems;
}

// What a stylesheet loads that the add-on does not ship.
const styleProblems = (text, url) => cssUrls(text).filter(ref => !ref.startsWith('#') && !insideAddOn(ref, url));

const IMAGE_FILE = /\.(?:png|jpe?g|gif|svg|webp|ico|bmp|avif)(?:[?#][^'"`\s]*)?$/i;

// What a page script writes that the policy blocks. It reads every string in
// the script, wherever it is used, so a source kept in a variable first or
// set over several lines is still seen.
function scriptProblems(source) {
  const problems = [];
  // Comments are not code: block comments, and line comments starting a line.
  const text = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const strings = [...text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*?)\1/gs)].map(m => m[2]);
  for (const s of strings) {
    const value = s.trim();
    if (/^data:[a-z]/i.test(value)) problems.push(`a data address: ${value.slice(0, 40)}`);
    if (/^blob:/i.test(value)) problems.push(`a blob address: ${value.slice(0, 40)}`);
    if (/^(?:https?:)?\/\//i.test(value) && IMAGE_FILE.test(value)) problems.push(`an image from outside: ${value}`);
    if (/<(?:iframe|frame|embed|object)[\s>]/.test(value)) problems.push('a frame in markup');
    for (const m of value.matchAll(/<(?:img|source|image|use)\b[^>]*?\b(?:src|srcset|href|xlink:href)\s*=\s*\\?["']\s*([^"'\\]*)/gi)) {
      for (const ref of srcsetCandidates(m[1])) if (!ref.startsWith('${') && !insideAddOn(ref, ORIGIN)) problems.push(`an image from outside in markup: ${ref}`);
    }
    for (const ref of cssUrls(value)) if (!ref.startsWith('${') && !insideAddOn(ref, ORIGIN)) problems.push(`a style image from outside: ${ref}`);
  }
  if (/createElement(?:NS)?\(\s*(?:[^,)]*,\s*)?['"`](?:iframe|frame|embed|object)['"`]/i.test(text)) problems.push('a frame made by script');
  // A blob address is only ever handed to a download, never shown.
  for (const m of text.matchAll(/createObjectURL\(/g)) {
    if (!/downloads\.download\(/.test(text.slice(m.index, m.index + 600))) problems.push('a blob address not handed to a download');
  }
  return problems;
}

// Every module a script imports, by its path in the add-on.
const importsOf = (text, from) => [
  ...text.matchAll(/\b(?:import|export)\b[^'"`;]*?\bfrom\s*['"]([^'"]+)['"]/g),
  ...text.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
  ...text.matchAll(/^\s*import\s*['"]([^'"]+)['"]/gm),
].map(m => m[1]).filter(spec => spec.startsWith('.') || spec.startsWith('/'))
  .map(spec => spec.startsWith('/') ? join(root, spec) : resolve(dirname(from), spec));

// Left out: the vendored PDF library, which the add-on uses only to read a
// PDF's text with its font and drawing paths off.
const vendored = path => /^chat\/libs\/pdfjs\//.test(rel(path));

// The scripts and stylesheets the pages and the background load.
function pageCode() {
  const scripts = new Set();
  const styles = new Set();
  const queue = manifest.background.scripts.map(s => join(root, s));
  for (const page of filesUnder(root, ['.html'])) {
    const { document } = new JSDOM(readFileSync(page, 'utf8')).window;
    for (const s of document.querySelectorAll('script[src]')) queue.push(resolve(dirname(page), s.getAttribute('src')));
    for (const l of document.querySelectorAll('link[rel~="stylesheet"]')) styles.add(resolve(dirname(page), l.getAttribute('href')));
  }
  while (queue.length) {
    const path = queue.pop();
    if (scripts.has(path) || vendored(path) || !existsSync(path)) continue;
    scripts.add(path);
    queue.push(...importsOf(readFileSync(path, 'utf8'), path));
  }
  for (const path of [...styles]) {
    if (!existsSync(path)) continue;
    for (const ref of cssUrls(readFileSync(path, 'utf8'))) if (ref.endsWith('.css')) styles.add(resolve(dirname(path), ref));
  }
  return { scripts: [...scripts].filter(existsSync), styles: [...styles].filter(existsSync) };
}

describe('the page policy', () => {
  it('allows images from the add-on only and no frames, and keeps the rest', () => {
    const csp = parsePolicy(manifest.content_security_policy.extension_pages);
    expect(csp['img-src']).toEqual(["'self'"]);
    expect(csp['frame-src']).toEqual(["'none'"]);
    expect(csp['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    expect(csp['worker-src']).toEqual(["'self'"]);
    expect(csp['object-src']).toEqual(["'self'"]);
    expect(csp['connect-src']).toEqual(["'self'", 'https://*.supabase.co', 'wss://*.supabase.co', 'https://*.tabmail.ai', 'wss://*.tabmail.ai']);
    expect(Object.keys(csp).sort()).toEqual(['connect-src', 'frame-src', 'img-src', 'object-src', 'script-src', 'worker-src']);
  });

  it('a repeated directive is refused, since the browser would use the first', () => {
    expect(() => parsePolicy("img-src https:; img-src 'self'")).toThrow('directive repeated: img-src');
    expect(() => parsePolicy("frame-src https:; FRAME-SRC 'none'")).toThrow('directive repeated');
    expect(parsePolicy("img-src 'self'; frame-src 'none'")).toEqual({ 'img-src': ["'self'"], 'frame-src': ["'none'"] });
  });
});

describe('the checks catch what the policy blocks', () => {
  const page = `${ORIGIN}chat/chat.html`;
  it.each([
    ['an image from outside', '<img src="https://example.com/a.png">'],
    ['an image address with a leading space', '<img src=" https://example.com/a.png">'],
    ['a data image', '<img src="data:image/png;base64,AAAA">'],
    ['a second srcset candidate from outside', '<img src="a.png" srcset="a.png 1x, https://example.com/b.png 2x">'],
    ['a picture source', '<picture><source srcset="https://example.com/b.png"><img src="a.png"></picture>'],
    ['an SVG image', '<svg><image href="https://example.com/a.png"></image></svg>'],
    ['an SVG use from outside', '<svg><use href="https://example.com/s.svg#i"></use></svg>'],
    ['a base address outside the add-on', '<base href="https://example.com/"><img src="a.png">'],
    ['an icon from outside', '<link rel="icon" href="https://example.com/i.ico">'],
    ['a style image from outside', '<div style="background: url(https://example.com/a.png)"></div>'],
    ['a style element image from outside', '<style>.x { background: url("//example.com/a.png") }</style>'],
    ['a frame', '<iframe src="frame.html"></iframe>'],
    ['an embed', '<embed src="a.pdf">'],
  ])('markup with %s', (_label, html) => {
    expect(markupProblems(html, page)).not.toEqual([]);
  });

  it('markup naming only the add-on\'s own images passes', () => {
    expect(markupProblems('<img src="../icons/a.png" srcset="../icons/a.png 1x, ../icons/b.png 2x"><link rel="icon" href="/icons/i.svg"><div style="background: url(\'a.png\')"></div>', page)).toEqual([]);
  });

  it.each([
    ['a data image kept in a variable first', 'const logo = "data:image/png;base64,AAAA";\nimg.src = logo;'],
    ['a remote image set over several lines', 'img.src =\n  isDark\n    ? "https://example.com/dark.png"\n    : "https://example.com/light.png";'],
    ['a frame made by script, its source set by name', 'const f = document.createElement("iframe");\nf["src"] = page;'],
    ['a frame written as markup', 'box.innerHTML = `<iframe src="x.html"></iframe>`;'],
    ['an image from outside written as markup', 'box.innerHTML = `<img src="https://example.com/a.png">`;'],
    ['a style image from outside', 'el.style.backgroundImage = "url(https://example.com/a.png)";'],
    ['a blob address shown, not downloaded', 'img.src = URL.createObjectURL(blob);'],
    ['a protocol-relative image', 'const u = "//example.com/a.png";'],
  ])('a script with %s', (_label, text) => {
    expect(scriptProblems(text)).not.toEqual([]);
  });

  it('a script naming its own images, reading a stream and saving a download passes', () => {
    expect(scriptProblems([
      'img.src = "../icons/logo-dark.png";',
      'if (line.startsWith("data:")) handle(line);',
      'const url = URL.createObjectURL(blob);',
      'await browser.downloads.download({ url, filename });',
      'fetch("https://api.example.com/v1/items");',
    ].join('\n'))).toEqual([]);
  });

  it.each([
    ['an image from outside', '.x { background: url(https://example.com/a.png) }'],
    ['an import from outside', '@import "https://example.com/a.css";'],
  ])('a stylesheet with %s', (_label, text) => {
    expect(styleProblems(text, `${ORIGIN}chat/chat.css`)).not.toEqual([]);
  });
});

describe('the add-on\'s pages use nothing the policy blocks', () => {
  const pages = filesUnder(root, ['.html']);
  const code = pageCode();

  it('finds the pages and the code they load', () => {
    expect(pages.map(rel)).toEqual(expect.arrayContaining(['chat/chat.html', 'config/config.html', 'prompts/prompts.html', 'popup/popup.html', 'welcome/welcome.html']));
    expect(code.scripts.map(rel)).toEqual(expect.arrayContaining([
      'chat/chat.js', 'prompts/prompts.js', 'popup/popup.js', 'config/config.js', 'welcome/welcome.js',
      'agent/background.js', 'chat/modules/markdown.js', 'prompts/modules/history.js', 'agent/modules/utils.js',
    ]));
    expect(code.styles.map(rel).length).toBeGreaterThan(0);
    expect(code.scripts.length).toBeGreaterThan(100);
    expect(code.scripts.some(vendored)).toBe(false);
  });

  it.each(pages.map(p => [rel(p), p]))('%s names only images the add-on ships and has no frame', (_name, path) => {
    expect(markupProblems(readFileSync(path, 'utf8'), pageUrl(path))).toEqual([]);
  });

  it('the scripts the pages load set no image or frame the policy blocks', () => {
    const problems = code.scripts.flatMap(path => scriptProblems(readFileSync(path, 'utf8')).map(p => `${rel(path)}: ${p}`));
    expect(problems).toEqual([]);
  });

  it('the stylesheets the pages load name only images the add-on ships', () => {
    const problems = code.styles.flatMap(path => styleProblems(readFileSync(path, 'utf8'), pageUrl(path)).map(p => `${rel(path)}: ${p}`));
    expect(problems).toEqual([]);
  });
});
