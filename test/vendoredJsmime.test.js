/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// vendoredJsmime.test.js — the tests' reference parser (test/vendor/jsmime) is Thunderbird's
// file unmodified: its SHA-256 is the one test/vendor/jsmime/README.md records.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

const read = rel => readFileSync(new URL(`./vendor/jsmime/${rel}`, import.meta.url));

it('jsmime.mjs is the unmodified file whose SHA-256 the README records', () => {
  const recorded = String(read('README.md')).match(/SHA-256 of `jsmime\.mjs`:\s*`([0-9a-f]{64})`/)?.[1];
  expect(recorded).toMatch(/^[0-9a-f]{64}$/);
  expect(createHash('sha256').update(read('jsmime.mjs')).digest('hex')).toBe(recorded);
});
