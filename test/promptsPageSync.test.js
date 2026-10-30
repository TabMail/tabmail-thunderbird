/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptsPageSync.test.js — the prompts page's edits (prompts/modules/storage.js) on simulated devices
// (bulletDevices.js), in a realm of their own that reaches the prompt store through the background as in
// the add-on. Each edit changes exactly the line or section the user acted on in the stored text: the
// field's head and footer stay as the device has them (DS-SKELETON), a line holding a section marker is
// refused with nothing changed on either device (R23), and a released rule holding the END text, once
// removed, gives the lines after it back as rules on every device.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';

const END = '====END USER INSTRUCTIONS====';
const OWN_FOOTER = 'My own closing line, typed before the update.';
const FIRST = { composition: 'general', action: 'delete' };
const SECOND = { composition: 'language', action: 'archive' };

function hex(value) {
  return value.toString(16).padStart(8, '0');
}

async function quiesce(relay) {
  while (await relay.deliverOldest()) { /* until nothing is pending */ }
}

const bundledText = (field) => readFileSync(new URL(`../prompts/user_${field}.md`, import.meta.url), 'utf8');
const shownTexts = async (device, field) => (await device.state(field)).bullets.map((bullet) => bullet.text);

/** Two connected devices: A holds `stored` (field to text from before, upgraded at its start), B the
 * defaults; and the page's storage module on A. */
async function twoDevices(stored = {}) {
  const relay = new BulletRelay();
  const released = Object.fromEntries(Object.entries(stored).map(([field, text]) => [PROMPT_KEYS[field], text]));
  const a = await new BulletDevice('A', new DeviceStore(released), relay, { name: (k) => `${hex(1)}${hex(k)}` }).start();
  const b = await new BulletDevice('B', new DeviceStore(), relay, { name: (k) => `${hex(2)}${hex(k)}` }).start();
  const page = a.page(['prompts/modules/markdown.js', 'prompts/modules/storage.js']);
  const storage = page.require('prompts/modules/storage.js');
  // What the page shows of a field now, with the labels it shows: every page action is made on it (DS-DISPLAYED).
  const view = (field) => page.require('agent/modules/promptStore.js').readView(field);
  await a.connect();
  await b.connect();
  await quiesce(relay);
  return { relay, a, b, storage, view };
}

describe('the prompts page on the sectioned fields', () => {
  it.each(['composition', 'action'])('keeps the %s footer the device has when the page adds a rule (DS-SKELETON)', async (field) => {
    const text = bundledText(field).replace('Now, acknowledge these user instructions and do not deviate from them.', OWN_FOOTER);
    const { a, storage, view } = await twoDevices({ [field]: text });
    const tail = [...a.store.values[`bullet_state:${field}`].tail];
    expect(tail).toContain(OWN_FOOTER);

    expect(await storage.addLine(field, await view(field), { key: FIRST[field], copy: 0 }, 'Newly typed rule')).toBe('saved');

    expect(await shownTexts(a, field)).toContain('Newly typed rule');
    expect(a.store.values[`bullet_state:${field}`].tail).toEqual(tail);
    expect(a.store.values[PROMPT_KEYS[field]].split('\n').slice(-tail.length)).toEqual(tail);
    expect(a.store.values[PROMPT_KEYS[field]].split(END)).toHaveLength(2);
  });

  it.each(['composition', 'action'])('adds no footer and drops none when the page adds a %s rule to the built-in text', async (field) => {
    const { a, storage, view } = await twoDevices();
    const { state: before } = await a.prompts.engine.read(field, () => true);
    expect(before.tail.join('\n')).toContain(END);

    await storage.addLine(field, await view(field), { key: FIRST[field], copy: 0 }, 'Newly typed rule');

    const after = a.store.values[`bullet_state:${field}`];
    expect(after.head).toEqual(before.head);
    expect(after.tail).toEqual(before.tail);
    expect(a.store.values[PROMPT_KEYS[field]].split(END)).toHaveLength(2);
  });

  it.each(['composition', 'action'])('keeps a %s head of one empty line when the page adds a rule (DS-SKELETON)', async (field) => {
    const lines = bundledText(field).split('\n');
    const stored = ['', ...lines.slice(lines.findIndex((line) => line.includes('(DO NOT EDIT/DELETE THIS SECTION HEADER)')))].join('\n');
    const { a, storage, view } = await twoDevices({ [field]: stored });
    expect(a.store.values[`bullet_state:${field}`].head).toEqual(['']);

    await storage.addLine(field, await view(field), { key: FIRST[field], copy: 0 }, 'Newly typed rule');

    expect(await shownTexts(a, field)).toContain('Newly typed rule');
    expect(a.store.values[`bullet_state:${field}`].head).toEqual(['']);
    expect(a.store.values[PROMPT_KEYS[field]].startsWith('\n# ')).toBe(true);
  });

  it.each([
    ['composition', 'Language'],
    ['action', 'Emails to be marked as `archive`'],
  ])('refuses a %s line naming a known section with its mark, and moves no rule on either device (R23)', async (field, other) => {
    const { relay, a, b, storage, view } = await twoDevices();
    await a.add(field, FIRST[field], 'A rule nobody moved');
    await quiesce(relay);
    const rule = (await a.state(field)).bullets.find((bullet) => bullet.text === 'A rule nobody moved');
    const before = structuredClone(a.store.values);

    await expect(storage.addLine(field, await view(field), { key: FIRST[field], copy: 0 }, `${other} (DO NOT EDIT/DELETE THIS SECTION HEADER) typed in a rule`)).rejects.toThrow("can't contain");

    await quiesce(relay);
    expect(a.store.values).toEqual(before);
    for (const device of [a, b]) {
      expect((await device.state(field)).bullets.find((bullet) => bullet.text === 'A rule nobody moved')).toEqual(rule);
    }
  });

  it.each(['## Use ====END USER INSTRUCTIONS==== here', 'Use ====END USER INSTRUCTIONS==== here'])('refuses the typed writing-style line "%s" (R23)', async (line) => {
    const { a, storage, view } = await twoDevices();
    const before = structuredClone(a.store.values);

    await expect(storage.addLine('composition', await view('composition'), { key: 'general', copy: 0 }, line)).rejects.toThrow("can't contain");

    expect(a.store.values).toEqual(before);
  });

  // The footer is the field's own, carried as it is: what it holds is not the user's typing.
  it.each([
    ['composition', 'a second END line', `${END}\nAfter the second end line.`],
    ['action', 'a second END line', `${END}\nAfter the second end line.`],
    ['composition', 'a line with the section-header mark', 'Keep each (DO NOT EDIT/DELETE THIS SECTION HEADER) line as it is.'],
    ['action', 'a line with the section-header mark', 'Keep each (DO NOT EDIT/DELETE THIS SECTION HEADER) line as it is.'],
  ])('adds %s rules and resets a section over a footer holding %s, keeping the footer and the other rules on both devices', async (field, _, extra) => {
    const { relay, a, b, storage, view } = await twoDevices({ [field]: `${bundledText(field).trimEnd()}\n${extra}\n` });
    const tail = [...a.store.values[`bullet_state:${field}`].tail];
    expect(tail.join('\n')).toContain(extra);

    await storage.addLine(field, await view(field), { key: FIRST[field], copy: 0 }, 'Newly typed rule');
    await quiesce(relay);
    for (const device of [a, b]) expect(await shownTexts(device, field)).toContain('Newly typed rule');
    expect(a.store.values[`bullet_state:${field}`].tail).toEqual(tail);

    // The page's section Reset: that section's lines replaced by its defaults, in one edit.
    expect(await storage.resetSection(field, await view(field), { key: SECOND[field], copy: 0 })).not.toBe('gone');
    await quiesce(relay);

    for (const device of [a, b]) expect(await shownTexts(device, field)).toContain('Newly typed rule');
    expect(a.store.values[`bullet_state:${field}`].tail).toEqual(tail);
  });

  it('lets the user remove a rule holding the END marker from an upgraded action text, and the lines after it are rules again on both devices, each under the last header before it', async () => {
    const lines = bundledText('action').split('\n');
    const rules = lines.slice(0, lines.indexOf(END));
    const after = (name, line) => rules.splice(rules.findIndex((other) => other.includes(`\`${name}\``)) + 1, 0, line);
    after('archive', '- Newsletters ====END USER INSTRUCTIONS==== go here.');
    after('reply', '- Rule R.');
    after('none', '- Rule N.');
    const { relay, a, b, storage, view } = await twoDevices({ action: rules.join('\n') });
    // The released text's rule ended the rules early: what follows it is the stored text's own lines.
    expect(await shownTexts(a, 'action')).not.toContain('Rule R.');
    expect(a.store.values['bullet_state:action'].tail.join('\n')).toContain('Rule R.');

    expect(await storage.editShown('action', await view('action'), (content) => content.split('\n').filter((line) => !line.includes('Newsletters')).join('\n'))).toBe('saved');
    await quiesce(relay);

    for (const device of [a, b]) {
      const bullets = (await device.state('action')).bullets;
      expect(bullets.filter((bullet) => ['Rule R.', 'Rule N.'].includes(bullet.text)).map(({ section, text }) => [section, text])).toEqual([['reply', 'Rule R.'], ['none', 'Rule N.']]);
    }
  });
});
