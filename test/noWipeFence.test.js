/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// R34: nothing on the device is wiped, at a sign-out, a sign-in or an account change. The texts, their
// labels, the prompt history, the templates, the reminder states and the AI caches are the device's. This
// fence reads every add-on source file: no code clears storage or deletes a database, no removal names one
// of those keys, and none of the deleted wipe functions comes back. The behaviour itself is tested in
// deviceSyncAccountChange, signInAccountSwitch and signedOutScreens; this catches a wipe added anywhere.

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const SKIPPED = new Set(['node_modules', 'test', 'libs', '.git']);

function sources(dir = ROOT) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return entry.name.endsWith('.js') || entry.name.endsWith('.mjs') ? [path] : [];
  });
}

const FILES = sources().map((path) => ({ path: relative(ROOT, path), text: readFileSync(path, 'utf8') }));

/** The device's keys a wipe would name: literals and the constants that hold them. */
const KEPT = [
  'user_prompts:', 'bullet_state:', 'prompt_history', 'user_templates', 'disabled_reminders', 'task_execution_cache',
  'RENDERED_KEYS', 'BULLET_STATE_KEYS', 'HISTORY_KEY', 'FIELD_KEYS', 'SYNC_FIELDS',
];

/** Every `storage.local.remove(...)` call's argument text, up to its closing parenthesis. */
function removals(text) {
  const found = [];
  const pattern = /storage\.local\.remove\(/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    let depth = 1;
    let end = pattern.lastIndex;
    while (end < text.length && depth > 0) {
      if (text[end] === '(') depth += 1;
      if (text[end] === ')') depth -= 1;
      end += 1;
    }
    found.push(text.slice(pattern.lastIndex, end - 1));
  }
  return found;
}

describe('no wipe path remains (R34)', () => {
  it('reads the add-on sources', () => {
    expect(FILES.some(({ path }) => path === join('agent', 'modules', 'promptStore.js'))).toBe(true);
    expect(FILES.some(({ path }) => path.startsWith('test'))).toBe(false);
  });

  it('no code clears storage or deletes a database', () => {
    const hits = FILES.filter(({ text }) => /storage\.local\.clear\(|indexedDB\.deleteDatabase\(|\bidb\.clear\(/.test(text)).map(({ path }) => path);
    expect(hits).toEqual([]);
  });

  it("no removal names the texts, the history, the templates, the reminder states or the task cache", () => {
    const hits = FILES.flatMap(({ path, text }) => removals(text).filter((args) => KEPT.some((key) => args.includes(key))).map((args) => `${path}: ${args}`));
    expect(hits).toEqual([]);
  });

  it('none of the deleted wipe functions is back', () => {
    const names = /\b(forgetFields|wipeAll|prepareForAccount|removeFields|signInGate)\b/;
    expect(FILES.filter(({ text }) => names.test(text)).map(({ path }) => path)).toEqual([]);
  });

  it('the fence sees a removal of a kept key', () => {
    expect(removals('await browser.storage.local.remove([HISTORY_KEY, "x"]);')).toEqual(['[HISTORY_KEY, "x"]']);
    expect(removals('browser.storage.local.remove(f(a), b)')).toEqual(['f(a), b']);
  });
});
