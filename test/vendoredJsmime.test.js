/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// vendoredJsmime.test.js — the tests' reference parsers (test/vendor/jsmime and
// test/vendor/mimejscomponents) are Thunderbird's files unmodified: each SHA-256 is the one
// its README records.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = rel => readFileSync(new URL(`./vendor/${rel}`, import.meta.url));

it.each([
  ['jsmime', 'jsmime.mjs'],
  ['mimejscomponents', 'MimeJSComponents-145.sys.mjs'],
  ['mimejscomponents', 'MimeJSComponents-161.sys.mjs'],
])('%s/%s is the unmodified file whose SHA-256 the README records', (dir, file) => {
  const label = file.replace(/\./g, '\\.');
  const recorded = String(read(`${dir}/README.md`)).match(new RegExp(`SHA-256 of \`${label}\`:\\s*\`([0-9a-f]{64})\``))?.[1];
  expect(recorded).toMatch(/^[0-9a-f]{64}$/);
  expect(createHash('sha256').update(read(`${dir}/${file}`)).digest('hex')).toBe(recorded);
});
