/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The add-on's pages load images only from the add-on and frame nothing. The
// manifest's page policy says so, and every image a page names is one the
// add-on ships, so the policy blocks nothing the pages use.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { JSDOM } from 'jsdom';

const root = process.cwd();
const skipped = new Set(['node_modules', 'test', '.git', 'coverage', 'web-ext-artifacts']);

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

const directives = () => {
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  return Object.fromEntries(manifest.content_security_policy.extension_pages
    .split(';').map(part => part.trim().split(/\s+/)).filter(words => words[0])
    .map(([name, ...sources]) => [name, sources]));
};

// A reference resolves inside the add-on when it names no scheme and no host.
const insideAddOn = ref => !/^[a-z][a-z0-9+.-]*:/i.test(ref) && !ref.startsWith('//');

describe('extension pages load only their own images and frame nothing', () => {
  it('the page policy allows images from the add-on only and no frames', () => {
    const csp = directives();
    expect(csp['img-src']).toEqual(["'self'"]);
    expect(csp['frame-src']).toEqual(["'none'"]);
    expect(csp['script-src']).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  });

  const pages = filesUnder(root, ['.html']);

  it('finds the pages', () => {
    expect(pages.map(p => relative(root, p))).toEqual(expect.arrayContaining(['chat/chat.html', 'config/config.html', 'prompts/prompts.html', 'welcome/welcome.html']));
  });

  it.each(pages.map(p => [relative(root, p), p]))('%s names only images the add-on ships and has no frame', (_name, path) => {
    const { document } = new JSDOM(readFileSync(path, 'utf8')).window;
    expect(document.querySelectorAll('iframe, frame, embed, object')).toHaveLength(0);
    const refs = [
      ...[...document.querySelectorAll('img')].flatMap(img => ['src', 'data-light-src', 'data-dark-src', 'srcset'].map(a => img.getAttribute(a))),
      ...[...document.querySelectorAll('link[rel~="icon"]')].map(link => link.getAttribute('href')),
      ...[...document.querySelectorAll('[style]')].flatMap(el => [...el.getAttribute('style').matchAll(/url\(\s*['"]?([^'")]+)/g)].map(m => m[1])),
    ].filter(Boolean);
    for (const ref of refs) expect(insideAddOn(ref), ref).toBe(true);
  });

  it('page scripts and styles set no image or frame from outside the add-on', () => {
    const offenders = [];
    // Left out: vendored libraries (the add-on uses pdf.js only to read a PDF's
    // text in a worker, never its font or image drawing paths) and experiment
    // code, which runs in Thunderbird's own windows under their policy.
    const notPageCode = path => /^(chat|compose)\/libs\/|(^|\/)experiments\//.test(relative(root, path));
    for (const path of filesUnder(root, ['.js', '.mjs', '.css']).filter(p => !notPageCode(p))) {
      const text = readFileSync(path, 'utf8');
      const refs = [
        // Every string in a src assignment or a src attribute set from script.
        ...[...text.matchAll(/\.src\s*=(?!=)([^;\n]*)|setAttribute\(\s*['"]src['"]\s*,([^;\n]*)/g)]
          .flatMap(m => [...(m[1] ?? m[2]).matchAll(/[`'"]([^`'"]*)[`'"]/g)].map(l => l[1])),
        ...[...text.matchAll(/url\(\s*['"]?([^'")]+)/g)].map(m => m[1]),
        ...[...text.matchAll(/<(?:img|iframe)\b[^>]*\bsrc\s*=\s*\\?["']([^"'\\]*)/g)].map(m => m[1]),
      ];
      for (const ref of refs) {
        if (ref && !ref.startsWith('${') && !insideAddOn(ref) && !ref.startsWith('moz-extension:')) offenders.push(`${relative(root, path)}: ${ref}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
