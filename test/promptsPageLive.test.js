/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// The prompts page as it runs: the shipped prompts.html and the real page module, on a device whose
// store syncs with a second device. Every edit on the page is saved at once; the page keeps no text of
// its own and shows what is stored. Every test drives the page's own buttons, tabs, keys and editors and
// checks one invariant: what the page shows equals what both devices hold, and every stored line,
// whatever its shape, survives on every device unless the user removed that exact line.

import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { displayedSections, parse, SECTION_HEADERS } from '../agent/modules/bullets.js';
import { BulletDevice, BulletRelay, defaultCatalog, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';
import { openPage, settleMany } from './support/promptsPage.js';

const ROOT = new URL('../', import.meta.url);
const END = '====END USER INSTRUCTIONS====';
const HEADER_MARK = 'DO NOT EDIT/DELETE THIS SECTION HEADER';
const REFUSAL = "A line can't contain";

// Lines of every shape a released field holds, as the store keeps them (one leading "- " taken off).
const SHAPES = [
  '- Dash rule.',
  '## Hash line',
  '# Lone hash line',
  'Plain line.',
  '   - Padded dash rule.   ',
  '-   Spaced dash rule.',
  '- - Dashed text.',
  '-Tight dash.',
  '\tTabbed plain line.',
  '* Star line.',
  '1. Numbered line.',
  '- ## Dash hash line.',
  '```',
];
const EARLY_END = {
  composition: { first: 'general', firstName: 'General writing style', later: 'language', laterName: 'Language' },
  action: { first: 'delete', firstName: '`delete`', later: 'archive', laterName: '`archive`' },
};
const asRule = (line) => (line.trim().startsWith('- ') ? line.trim().slice(2).trim() : line.trim());
const RULES = SHAPES.map(asRule);
const AT = {
  composition: { shapes: 'general', other: 'language', name: 'General writing style', otherName: 'Language' },
  action: { shapes: 'reply', other: 'archive', name: '`reply`', otherName: '`archive`' },
  kb: { shapes: '' },
};

async function quiesce(relay) {
  for (let n = 0; n < 1000; n++) {
    if (!(await relay.deliverOldest())) return;
  }
  throw new Error('the relay did not settle');
}

async function flush(relay) {
  for (let round = 0; round < 3; round++) {
    await settleMany(30);
    await quiesce(relay);
  }
}

/** How long a page action waits in line for the semaphore: no page test expects a busy answer, so an action
 * that waits behind another's write under load must not get one. */
const PAGE_WAIT_MS = 4000;

/** Devices A and B; A starts from `stored` (field to released text), upgraded at its start. */
async function devices({ connected = true, stored = {} } = {}) {
  const relay = new BulletRelay();
  const released = Object.fromEntries(Object.entries(stored).map(([field, text]) => [PROMPT_KEYS[field], text]));
  const a = await new BulletDevice('A', new DeviceStore(released), relay, { name: (k) => `000000030000000${k}`, acquireWaitMs: PAGE_WAIT_MS }).start();
  const b = await new BulletDevice('B', new DeviceStore(), relay, { name: (k) => `000000010000000${k}` }).start();
  if (connected) {
    await a.connect();
    await b.connect();
    await quiesce(relay);
  }
  return { a, b, relay };
}

async function seeded(fields) {
  const opened = await devices();
  for (const field of fields) {
    for (const rule of RULES) await opened.a.add(field, AT[field].shapes, rule);
  }
  await flush(opened.relay);
  return opened;
}

const bundled = (field) => readFileSync(new URL(`prompts/user_${field}.md`, ROOT), 'utf8');

/** A released text of `field`: the bundled one with `lines` typed right after the header holding `name`. */
function released(field, typed) {
  const lines = bundled(field).split('\n');
  for (const [name, added] of typed) lines.splice(lines.findIndex((line) => line.startsWith('# ') && line.includes(name)) + 1, 0, ...added);
  return lines.join('\n');
}

const sorted = (pairs) => [...pairs].sort((x, y) => `${x[0]}\u0000${x[1]}`.localeCompare(`${y[0]}\u0000${y[1]}`));
const held = async (device, field) => sorted((await device.state(field)).bullets.map(({ section, text }) => [section, text]));
const without = (pairs, gone) => pairs.filter(([key, text]) => !gone.some(([k, t]) => k === key && t === text));
const defaultsOf = (field) => sorted(defaultCatalog.defaults.filter((entry) => entry.field === field).map((entry) => [entry.section, entry.text]));
const textOf = (device, field) => device.store.values[PROMPT_KEYS[field]];

/** Both devices hold `expected`, and the page shows exactly what its device holds. */
async function holdsEverywhere({ a, b }, ui, field, expected) {
  expect(await held(a, field)).toEqual(sorted(expected));
  expect(await held(b, field)).toEqual(sorted(expected));
  expect(sorted(ui.shown(field))).toEqual(sorted(expected));
}

describe('the real prompts page saves each edit at once and keeps every stored line of every shape on every device, unless the user removed it', () => {
  it('has no Save or Reload buttons: each edit is saved when it is made, and the page shows what is stored', async () => {
    const html = readFileSync(new URL('prompts/prompts.html', ROOT), 'utf8');
    for (const id of ['save-changes', 'reload-prompts', 'save-kb', 'reload-kb', 'reload-raw-composition', 'reset-raw-composition', 'reload-raw-action', 'reset-raw-action', 'reload-raw-kb', 'reset-raw-kb']) {
      expect(html).not.toContain(`id="${id}"`);
    }
    const ui = await openPage((await seeded([])).a);
    const labels = [...ui.document.querySelectorAll('button')].map((button) => button.textContent.trim());
    expect(labels.filter((label) => /^(Save|Reload)\b/.test(label))).toEqual([]);
    ui.dom.window.close();
  });

  for (const field of ['composition', 'action']) {
    const { shapes, other } = AT[field];

    describe(`the ${field} field`, () => {
      it('opening the page shows exactly the stored rules, every shape, each in its section, counts them, and shows the stored text raw', async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        const before = await held(opened.a, field);
        for (const rule of RULES) expect(before).toContainEqual([shapes, rule]);
        await holdsEverywhere(opened, ui, field, before);
        if (field === 'action') {
          for (const [key] of SECTION_HEADERS.action) {
            expect(ui.section(field, key).querySelector('.kb-entry-count').textContent).toBe(` (${before.filter(([k]) => k === key).length})`);
          }
        }
        expect(ui.raw(field)).toBe(textOf(opened.a, field));
        ui.dom.window.close();
      });

      it("a peer's rule stored while another tab shows is there on coming back, raw view included", async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        await ui.tab('kb');
        await opened.b.add(field, shapes, '## Peer heading');
        await flush(opened.relay);
        await ui.tab(field);
        const after = await held(opened.a, field);
        expect(after).toContainEqual([shapes, '## Peer heading']);
        await holdsEverywhere(opened, ui, field, after);
        expect(ui.raw(field)).toBe(textOf(opened.a, field));
        ui.dom.window.close();
      });

      it("a peer's rule stored while the page first reads the field is shown, not the older text that read returned", async () => {
        const opened = await seeded([field]);
        let read;
        // The peer's rule arrives while the page's read holds the semaphore: its merge waits for the
        // page to let go, then is saved, and the page shows it.
        const ui = await openPage(opened.a, {
          afterStore: async (message) => {
            if (message.op !== 'read' || message.field !== field || read) return;
            read = (async () => {
              await opened.b.add(field, shapes, 'Peer rule during the load.');
              await flush(opened.relay);
            })();
          },
        });
        await read;
        await flush(opened.relay);
        const after = await held(opened.a, field);
        expect(after).toContainEqual([shapes, 'Peer rule during the load.']);
        await holdsEverywhere(opened, ui, field, after);
        expect(ui.raw(field)).toBe(textOf(opened.a, field));
        ui.dom.window.close();
      });

      it("a peer's change shown while the user types in an add box keeps the box focused, its text and caret where they were", async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        await ui.tab(field);
        const input = ui.type(field, shapes, 'Half typed');
        input.focus();
        input.setSelectionRange(4, 4);
        await opened.b.add(field, other, 'Peer rule.');
        await flush(opened.relay);
        const now = ui.editor(field, shapes).querySelector('.bullet-add-input');
        expect(now).not.toBe(input);
        expect(ui.items(field, other)).toContain('Peer rule.');
        expect(ui.document.activeElement).toBe(now);
        expect([now.value, now.selectionStart]).toEqual(['Half typed', 4]);
        ui.dom.window.close();
      });

      it("a line's remove button removes that line, and only it, at once on both devices", async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        const before = await held(opened.a, field);
        await ui.remove(field, shapes, '## Hash line');
        await flush(opened.relay);
        expect(ui.lastStatus()).toEqual(['Saved']);
        await holdsEverywhere(opened, ui, field, without(before, [[shapes, '## Hash line']]));
        if (field === 'action') {
          expect(ui.section(field, shapes).querySelector('.kb-entry-count').textContent).toBe(` (${ui.items(field, shapes).length})`);
        }
        ui.dom.window.close();
      });

      it('removing every shape, one by one, removes exactly each line on both devices', async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        let expected = await held(opened.a, field);
        for (const rule of RULES) {
          await ui.remove(field, shapes, rule);
          await flush(opened.relay);
          expected = without(expected, [[shapes, rule]]);
          await holdsEverywhere(opened, ui, field, expected);
        }
        ui.dom.window.close();
      });

      it('two remove buttons pressed back to back remove exactly those two lines', async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        const before = await held(opened.a, field);
        ui.removeNow(field, shapes, '## Hash line');
        ui.removeNow(field, shapes, 'Plain line.');
        await flush(opened.relay);
        await holdsEverywhere(opened, ui, field, without(before, [[shapes, '## Hash line'], [shapes, 'Plain line.']]));
        ui.dom.window.close();
      });

      it('a rule added with Enter is saved at once on both devices, and its box empties', async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        const before = await held(opened.a, field);
        await ui.enter(field, shapes, '## Added with Enter');
        await flush(opened.relay);
        expect(ui.lastStatus()).toEqual(['Saved']);
        expect(ui.box(field, shapes)).toEqual({ value: '', error: '' });
        await holdsEverywhere(opened, ui, field, [...before, [shapes, '## Added with Enter']]);
        ui.dom.window.close();
      });

      it('a rule added with the Add button is saved at once on both devices, in the section it was typed in', async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        const before = await held(opened.a, field);
        await ui.add(field, other, '# Added with the button');
        await flush(opened.relay);
        await holdsEverywhere(opened, ui, field, [...before, [other, '# Added with the button']]);
        ui.dom.window.close();
      });

      it("removing a section's every line empties that section on both devices, every other section kept", async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        const before = await held(opened.a, field);
        const gone = before.filter(([key]) => key === other);
        expect(gone.length).toBeGreaterThan(0);
        for (const [, text] of gone) await ui.remove(field, other, text);
        await flush(opened.relay);
        expect(ui.items(field, other)).toEqual([]);
        await holdsEverywhere(opened, ui, field, without(before, gone));
        ui.dom.window.close();
      });

      it("a section's Reset puts that section's defaults in place of its lines, on both devices, every other section and field kept", async () => {
        const opened = await seeded([field, 'kb']);
        const ui = await openPage(opened.a);
        const before = await held(opened.a, field);
        const kb = await held(opened.a, 'kb');
        await ui.resetSection(field, shapes);
        await flush(opened.relay);
        expect(ui.lastStatus()[0]).toMatch(/^Reset: /);
        const sectionDefaults = defaultsOf(field).filter(([key]) => key === shapes);
        expect(sectionDefaults.length).toBeGreaterThan(0);
        await holdsEverywhere(opened, ui, field, [...before.filter(([key]) => key !== shapes), ...sectionDefaults]);
        await holdsEverywhere(opened, ui, 'kb', kb);
        ui.dom.window.close();
      });

      it('Reset Entire Prompt stores exactly the defaults of that field alone; the peer then brings its lines back', async () => {
        const opened = await seeded([field, 'kb']);
        const otherField = field === 'composition' ? 'action' : 'composition';
        const ui = await openPage(opened.a);
        await ui.tab(field);
        const kb = await held(opened.a, 'kb');
        const untouched = await held(opened.a, otherField);
        await ui.click('#reset-prompt');
        await vi.waitFor(() => expect(ui.lastStatus()[0]).toMatch(/^Reset entire /), { timeout: 4000 });
        await settleMany(30);
        // Before anything is delivered: A holds the catalog defaults, and the page shows them.
        expect(await held(opened.a, field)).toEqual(defaultsOf(field));
        expect(sorted(ui.shown(field))).toEqual(defaultsOf(field));
        expect(await held(opened.a, 'kb')).toEqual(kb);
        expect(await held(opened.a, otherField)).toEqual(untouched);
        expect(ui.lastStatus()[0]).toMatch(/^Reset entire /);
        // A reset is local: the peer's lines come back (DS-RESET), and the page shows them.
        await flush(opened.relay);
        const after = await held(opened.a, field);
        expect(after).toContainEqual([shapes, '## Hash line']);
        await holdsEverywhere(opened, ui, field, after);
        ui.dom.window.close();
      });

      it('Reset Entire Prompt resets the field of the tab it was clicked on, even when the tab changes before it is done', async () => {
        const opened = await devices({ connected: false });
        await opened.a.add('kb', '', 'A fact only this device holds.');
        const ui = await openPage(opened.a);
        await ui.tab(field);
        const kb = await held(opened.a, 'kb');
        ui.document.querySelector('#reset-prompt').click();
        await ui.tab('kb');
        await settleMany();
        expect(await held(opened.a, field)).toEqual(defaultsOf(field));
        expect(await held(opened.a, 'kb')).toEqual(kb);
        expect(sorted(ui.shown('kb'))).toEqual(kb);
        ui.dom.window.close();
      });

      it('Sync Now, pressed from another tab, shows what the peers sent once it is stored', async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a, {
          commands: { 'device-sync-now': async () => { await opened.b.add(field, shapes, 'Sent by the peer.'); return { ok: true }; } },
        });
        await ui.tab('kb');
        await ui.click('#sync-now-btn');
        await flush(opened.relay);
        await ui.tab(field);
        expect(ui.commands).toContain('device-sync-now');
        const after = await held(opened.a, field);
        expect(after).toContainEqual([shapes, 'Sent by the peer.']);
        await holdsEverywhere(opened, ui, field, after);
        ui.dom.window.close();
      });

      if (field === 'action') {
        it('Compact Now asks the background to compact, and the page shows the rules it stored', async () => {
          const opened = await seeded([field]);
          const ui = await openPage(opened.a, {
            commands: {
              'action-compact-now': async () => {
                await opened.a.delete(field, shapes, 'Plain line.');
                return { ok: true, applied: 1 };
              },
            },
          });
          await ui.tab(field);
          const before = await held(opened.a, field);
          await ui.click('#action-compact-now');
          await flush(opened.relay);
          expect(ui.commands).toContain('action-compact-now');
          expect(ui.lastStatus()).toEqual(['Merged 1 rule']);
          await holdsEverywhere(opened, ui, field, without(before, [[shapes, 'Plain line.']]));
          ui.dom.window.close();
        });
      }

      for (const marker of [`Use ${END} here`, `# Mine (${HEADER_MARK})`]) {
        it(`a typed line holding "${marker.slice(0, 12)}…" is refused and stays in its box with the reason, through a peer's change, until the user changes it (R23)`, async () => {
          const opened = await seeded([field]);
          const ui = await openPage(opened.a);
          const stored = { a: structuredClone(opened.a.store.values), b: structuredClone(opened.b.store.values) };
          await ui.enter(field, shapes, marker);
          await flush(opened.relay);
          expect(ui.box(field, shapes)).toEqual({ value: marker, error: expect.stringContaining(REFUSAL) });
          expect(opened.a.store.values).toEqual(stored.a);
          expect(opened.b.store.values).toEqual(stored.b);
          // A peer's text change arrives and is shown; the refused line stays where the user typed it.
          await opened.b.add(field, shapes, 'Peer rule.');
          await flush(opened.relay);
          expect(ui.box(field, shapes)).toEqual({ value: marker, error: expect.stringContaining(REFUSAL) });
          const before = await held(opened.a, field);
          expect(before).toContainEqual([shapes, 'Peer rule.']);
          await holdsEverywhere(opened, ui, field, before);
          // The user changes the line; the reason goes, and the line is added.
          await ui.enter(field, shapes, 'Use the marker nowhere.');
          await flush(opened.relay);
          expect(ui.box(field, shapes)).toEqual({ value: '', error: '' });
          await holdsEverywhere(opened, ui, field, [...before, [shapes, 'Use the marker nowhere.']]);
          ui.dom.window.close();
        });
      }

      it('an edit the store could not write is reported, no success shown, and every line kept; the next one is saved', async () => {
        const opened = await seeded([field]);
        const ui = await openPage(opened.a);
        const before = await held(opened.a, field);
        opened.a.store.failNext = true;
        await ui.remove(field, shapes, '## Hash line');
        await flush(opened.relay);
        expect(ui.lastStatus()).toEqual([expect.stringMatching(/^Failed to save: /), true]);
        expect(ui.statuses.some(([text]) => text === 'Saved')).toBe(false);
        await holdsEverywhere(opened, ui, field, before);
        await ui.remove(field, shapes, '## Hash line');
        await flush(opened.relay);
        await holdsEverywhere(opened, ui, field, without(before, [[shapes, '## Hash line']]));
        ui.dom.window.close();
      });

      // The peer's rule arrives while the edit holds the semaphore between its read and its write: its
      // merge waits for the edit to let go, then is saved on top of it.
      it("a peer's rule arriving between an edit's read and its save is kept on both devices and shown", async () => {
        const opened = await seeded([field]);
        let peer = null;
        const ui = await openPage(opened.a, {
          beforeStore: async (message) => {
            if (message.op !== 'write' || peer === null) return;
            merged = peer();
            peer = null;
          },
        });
        const before = await held(opened.a, field);
        let merged;
        peer = async () => {
          await opened.b.add(field, shapes, 'Merged meanwhile.');
          await quiesce(opened.relay);
        };
        await ui.remove(field, shapes, 'Plain line.');
        await merged;
        await flush(opened.relay);
        await holdsEverywhere(opened, ui, field, [...without(before, [[shapes, 'Plain line.']]), [shapes, 'Merged meanwhile.']]);
        ui.dom.window.close();
      });
    });
  }

  // A released text: every line of a section, whatever its shape, is a rule (R26). A rule holding the
  // END text starts the store's footer, so the page shows the sections after it a second time, from the
  // footer, and each action there changes exactly the line it was made on.
  for (const field of ['composition', 'action']) {
    const { shapes, name } = AT[field];
    const tailLines = ['## Tail hash line', 'Tail plain line.', '```', '- Tail rule.', `# Custom rule (${HEADER_MARK})`];

    describe(`a released ${field} text`, () => {
      it('shows every typed line of every shape, and removing each removes it alone on both devices', async () => {
        const opened = await devices({ stored: { [field]: released(field, [[name, SHAPES]]) } });
        await flush(opened.relay);
        const ui = await openPage(opened.a);
        let expected = await held(opened.a, field);
        for (const rule of RULES) expect(expected).toContainEqual([shapes, rule]);
        await holdsEverywhere(opened, ui, field, expected);
        for (const rule of RULES) {
          await ui.remove(field, shapes, rule);
          await flush(opened.relay);
          expected = without(expected, [[shapes, rule]]);
          await holdsEverywhere(opened, ui, field, expected);
        }
        ui.dom.window.close();
      });

      describe('with a rule holding the END text before a later section', () => {
        // The END rule in the first section starts the store's footer: the store renders it after its
        // sections, so the page shows it at the end of the last one, and the later sections again after it.
        const { first, firstName, later, laterName } = EARLY_END[field];
        const endRule = `Sign off with ${END} always.`;
        const text = () => released(field, [[firstName, [`- ${endRule}`]], [laterName, tailLines]]);
        const open = async () => {
          const opened = await devices({ stored: { [field]: text() } });
          await flush(opened.relay);
          const ui = await openPage(opened.a);
          expect(ui.locate(field, 'Tail plain line.')).toEqual({ key: later, copy: 1 });
          return { opened, ui };
        };
        /** What the store reads from `stored` in the sections the page shows. */
        const readBack = (stored) => sorted([...new Set(parse(field, stored).bullets.filter((item) => displayedSections(field).includes(item.section)).map((item) => JSON.stringify([item.section, item.text])))].map((pair) => JSON.parse(pair)));
        const heldOnBoth = async ({ a, b }, expected) => {
          expect(await held(a, field)).toEqual(sorted(expected));
          expect(await held(b, field)).toEqual(sorted(expected));
        };

        it("shows the END rule and the footer's lines, a marked line among them as a line, and the stored text raw", async () => {
          const { opened, ui } = await open();
          expect(ui.locate(field, endRule)).toBeDefined();
          for (const line of tailLines) expect(ui.items(field, later, 1)).toContain(asRule(line));
          expect(ui.raw(field)).toBe(textOf(opened.a, field));
          ui.dom.window.close();
        });

        it('removing a footer line removes exactly that line from the stored text, and nothing on the peer', async () => {
          const { opened, ui } = await open();
          const stored = textOf(opened.a, field);
          const peer = await held(opened.b, field);
          await ui.remove(field, later, 'Tail plain line.', 1);
          await flush(opened.relay);
          expect(textOf(opened.a, field)).toBe(stored.split('\n').filter((line) => line !== 'Tail plain line.').join('\n'));
          expect(await held(opened.b, field)).toEqual(peer);
          ui.dom.window.close();
        });

        it('removing the END rule while a marked line would become a rule is refused, with nothing changed (R23)', async () => {
          const { opened, ui } = await open();
          const stored = { a: structuredClone(opened.a.store.values), b: structuredClone(opened.b.store.values) };
          const { key, copy } = ui.locate(field, endRule);
          await ui.remove(field, key, endRule, copy);
          await flush(opened.relay);
          expect(ui.lastStatus()).toEqual([expect.stringContaining(REFUSAL), true]);
          expect(opened.a.store.values).toEqual(stored.a);
          expect(opened.b.store.values).toEqual(stored.b);
          expect(ui.locate(field, endRule)).toEqual({ key, copy });
          ui.dom.window.close();
        });

        it('removing the marked line, then the END rule, makes every later line a rule on both devices, and the page shows them', async () => {
          const { opened, ui } = await open();
          const marked = `# Custom rule (${HEADER_MARK})`;
          const expected = readBack(textOf(opened.a, field).split('\n').filter((line) => line !== marked && line !== `- ${endRule}`).join('\n'));
          for (const line of tailLines.filter((one) => one !== marked)) expect(expected).toContainEqual([later, asRule(line)]);
          await ui.remove(field, later, marked, 1);
          const { key, copy } = ui.locate(field, endRule);
          await ui.remove(field, key, endRule, copy);
          await flush(opened.relay);
          await holdsEverywhere(opened, ui, field, expected);
          ui.dom.window.close();
        });

        it("a line added to the footer's copy of a section goes there, every other line kept", async () => {
          const { opened, ui } = await open();
          const stored = textOf(opened.a, field).split('\n');
          const items = ui.items(field, later, 1);
          await ui.add(field, later, 'Added to the footer copy.', 1);
          await flush(opened.relay);
          expect(textOf(opened.a, field).split('\n').filter((line) => line !== '- Added to the footer copy.')).toEqual(stored);
          expect(ui.items(field, later, 1)).toEqual([...items, 'Added to the footer copy.']);
          ui.dom.window.close();
        });

        it("a Reset of the footer's copy of a section replaces that copy's lines alone", async () => {
          const { opened, ui } = await open();
          const before = await held(opened.a, field);
          const firstCopy = ui.items(field, later, 0);
          await ui.resetSection(field, later, 1);
          await flush(opened.relay);
          expect(ui.items(field, later, 0)).toEqual(firstCopy);
          expect(ui.items(field, later, 1)).toEqual(defaultCatalog.defaults.filter((entry) => entry.field === field && entry.section === later).map((entry) => entry.text));
          await heldOnBoth(opened, before);
          ui.dom.window.close();
        });

        it("a Reset of the footer's copy whose write fails is reported, every line kept; the retry resets that copy", async () => {
          const { opened, ui } = await open();
          const before = await held(opened.a, field);
          const copies = [ui.items(field, later, 0), ui.items(field, later, 1)];
          opened.a.store.failNext = true;
          await ui.resetSection(field, later, 1);
          await flush(opened.relay);
          expect(ui.lastStatus()).toEqual([expect.stringMatching(/^Failed to reset: /), true]);
          expect(ui.statuses.some(([status]) => status.startsWith('Reset: '))).toBe(false);
          expect([ui.items(field, later, 0), ui.items(field, later, 1)]).toEqual(copies);
          await heldOnBoth(opened, before);
          await ui.resetSection(field, later, 1);
          await flush(opened.relay);
          expect(ui.lastStatus()[0]).toMatch(/^Reset: /);
          expect(ui.items(field, later, 0)).toEqual(copies[0]);
          expect(ui.items(field, later, 1)).toEqual(defaultCatalog.defaults.filter((entry) => entry.field === field && entry.section === later).map((entry) => entry.text));
          ui.dom.window.close();
        });
      });

      it('keeps a padded END line and everything after it as the footer, out of the page, through an edit', async () => {
        const opened = await devices({ stored: { [field]: released(field, [[name, ['- Rule before.', `   ${END}   `, '- After the padded END.']]]) } });
        await flush(opened.relay);
        const ui = await openPage(opened.a);
        expect(ui.shown(field)).not.toContainEqual([shapes, 'After the padded END.']);
        const stored = textOf(opened.a, field);
        await ui.add(field, shapes, 'New rule.');
        await flush(opened.relay);
        const tail = stored.slice(stored.indexOf(`   ${END}   `));
        expect(textOf(opened.a, field).endsWith(tail)).toBe(true);
        ui.dom.window.close();
      });
    });
  }

  describe('the knowledge base', () => {
    it('opening the page shows exactly the stored lines, every shape, counts them, and shows the text raw', async () => {
      const opened = await seeded(['kb']);
      const ui = await openPage(opened.a);
      const before = await held(opened.a, 'kb');
      for (const rule of RULES) expect(before).toContainEqual(['', rule]);
      await holdsEverywhere(opened, ui, 'kb', before);
      expect(ui.document.getElementById('kb-entry-count').textContent).toMatch(new RegExp(`^\\(${before.length}/`));
      expect(ui.raw('kb')).toBe(textOf(opened.a, 'kb'));
      ui.dom.window.close();
    });

    it("a line's remove button removes that line only, at once, on both devices, and the count follows", async () => {
      const opened = await seeded(['kb']);
      const ui = await openPage(opened.a);
      const before = await held(opened.a, 'kb');
      await ui.remove('kb', '', '# Lone hash line');
      await flush(opened.relay);
      await holdsEverywhere(opened, ui, 'kb', without(before, [['', '# Lone hash line']]));
      expect(ui.document.getElementById('kb-entry-count').textContent).toMatch(new RegExp(`^\\(${before.length - 1}/`));
      ui.dom.window.close();
    });

    it('an entry added with Enter or the Add button is saved at once on both devices', async () => {
      const opened = await seeded(['kb']);
      const ui = await openPage(opened.a);
      const before = await held(opened.a, 'kb');
      await ui.enter('kb', '', 'Entered fact.');
      await ui.add('kb', '', `A fact holding ${END}.`);
      await flush(opened.relay);
      await holdsEverywhere(opened, ui, 'kb', [...before, ['', 'Entered fact.'], ['', `A fact holding ${END}.`]]);
      ui.dom.window.close();
    });

    it('removing every line empties the knowledge base on both devices', async () => {
      const opened = await seeded(['kb']);
      const ui = await openPage(opened.a);
      for (const [, text] of await held(opened.a, 'kb')) await ui.remove('kb', '', text);
      await flush(opened.relay);
      await holdsEverywhere(opened, ui, 'kb', []);
      ui.dom.window.close();
    });

    it('Reset stores exactly the defaults of the knowledge base alone; the peer then brings its lines back', async () => {
      const opened = await seeded(['kb', 'composition']);
      const ui = await openPage(opened.a);
      const composition = await held(opened.a, 'composition');
      await ui.click('#reset-kb');
      await vi.waitFor(() => expect(ui.lastStatus()[0]).toMatch(/^Reset entire /), { timeout: 4000 });
      await settleMany(30);
      expect(await held(opened.a, 'kb')).toEqual(defaultsOf('kb'));
      expect(sorted(ui.shown('kb'))).toEqual(defaultsOf('kb'));
      expect(await held(opened.a, 'composition')).toEqual(composition);
      await flush(opened.relay);
      const after = await held(opened.a, 'kb');
      expect(after).toContainEqual(['', '## Hash line']);
      await holdsEverywhere(opened, ui, 'kb', after);
      ui.dom.window.close();
    });

    it('an add the store could not write is reported, keeps the typed line in its box, and shows no success', async () => {
      const opened = await seeded(['kb']);
      const ui = await openPage(opened.a);
      const before = await held(opened.a, 'kb');
      opened.a.store.failNext = true;
      await ui.enter('kb', '', 'Not written.');
      await flush(opened.relay);
      expect(ui.lastStatus()).toEqual([expect.stringMatching(/^Failed to save: /), true]);
      expect(ui.statuses.some(([text]) => text === 'Saved')).toBe(false);
      expect(ui.box('kb', '').value).toBe('Not written.');
      await holdsEverywhere(opened, ui, 'kb', before);
      ui.dom.window.close();
    });
  });
});

/** A promise and the function that resolves it. */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Sign-out on device `d`, as the background runs it: Device Sync closed. The prompt store is not reached,
 * and nothing is removed (DS-DEVICE). */
async function signOut(d) {
  await d.sync.cleanupDeviceSync();
}

const FIELDS = ['composition', 'action', 'kb'];
const keysOf = (field) => (field === 'kb' ? [''] : SECTION_HEADERS[field].map(([key]) => key).filter((key) => displayedSections(field).includes(key)));

describe('the real prompts page shows the catalog defaults where nothing is stored, and keeps its lines at a sign-out', () => {
  for (const field of FIELDS) {
    it(`a new install's ${field} page shows its defaults, each section with its add box`, async () => {
      const opened = await devices({ connected: false });
      const ui = await openPage(opened.a);
      await ui.tab(field);
      expect(defaultsOf(field).length).toBeGreaterThan(0);
      expect(sorted(ui.shown(field))).toEqual(defaultsOf(field));
      expect(await held(opened.a, field)).toEqual(defaultsOf(field));
      for (const key of keysOf(field)) expect(ui.box(field, key)).toEqual({ value: '', error: '' });
      ui.dom.window.close();
    });

    it(`after a sign-out the open ${field} page keeps showing every line (DS-DEVICE)`, async () => {
      const opened = await seeded([field]);
      const ui = await openPage(opened.a);
      await ui.tab(field);
      const shown = sorted(ui.shown(field));
      expect(shown).toContainEqual([AT[field].shapes, 'Plain line.']);
      await signOut(opened.a);
      await settleMany(30);
      expect(sorted(ui.shown(field))).toEqual(shown);
      ui.dom.window.close();
    });
  }
});

// DS-SEMAPHORE and DS-CAPTURE: every edit of the page writes its field in one hold of the prompt semaphore,
// against the labels the page showed, so edits and a Reset run one at a time. An add shown before a Reset
// that commits after it adds only its new line: what the Reset cleared is not brought back. A sign-out never
// reaches the prompt store, so an edit made before it is saved like any other (DS-DEVICE).
describe('the real prompts page runs its edits, a reset and a sign-out one at a time', () => {
  /** The page on A, the first edit's write held until `release()`. */
  async function heldPage(opened) {
    const hold = gate();
    let holding = true;
    const ui = await openPage(opened.a, {
      beforeStore: async (message) => {
        if (message.op !== 'write' || !holding) return;
        holding = false;
        await hold.promise;
      },
    });
    return { ui, release: hold.open };
  }

  for (const field of FIELDS) {
    const key = AT[field].shapes;

    it(`two ${field} adds and a Reset, the first add still saving, end as one of them run after another; the Reset's clearing is never undone; one made after is saved`, async () => {
      const opened = await devices({ connected: false });
      await opened.a.add(field, key, 'Kept until the reset.');
      const { ui, release } = await heldPage(opened);
      await ui.tab(field);
      await ui.enter(field, key, 'First, saving.');
      await ui.enter(field, key, 'Second, waiting.');
      await ui.click(field === 'kb' ? '#reset-kb' : '#reset-prompt');
      release();
      // Both adds and the Reset have answered, each saved.
      await vi.waitFor(() => {
        expect(ui.statuses.filter(([text]) => text === 'Saved').length).toBe(2);
        expect(ui.statuses.some(([text]) => text.startsWith('Reset entire'))).toBe(true);
      }, { timeout: 4000 });
      await settleMany(30);
      expect(ui.statuses.filter(([, error]) => error)).toEqual([]);

      // The first add saved before the Reset, which then removed it. The second ran before the Reset
      // (removed with it) or after it: then it adds its own new line and nothing the Reset cleared.
      const order = ui.statuses.filter(([text]) => text === 'Saved' || text.startsWith('Reset entire')).map(([text]) => text);
      const secondAfterReset = order.at(-1) === 'Saved';
      const stored = await held(opened.a, field);
      expect(sorted(stored)).toEqual(sorted([...defaultsOf(field), ...(secondAfterReset ? [[key, 'Second, waiting.']] : [])]));
      for (const typed of ['First, saving.', 'Kept until the reset.']) expect(textOf(opened.a, field)).not.toContain(typed);
      expect(sorted(ui.shown(field))).toEqual(sorted(stored));

      await ui.enter(field, key, 'Made after the reset.');
      expect(await held(opened.a, field)).toEqual(sorted([...stored, [key, 'Made after the reset.']]));
      expect(ui.lastStatus()[0]).toBe('Saved');
      ui.dom.window.close();
    });

    it(`two ${field} adds made before a sign-out, the first still saving, are both saved and reach the peer after the next sign-in (DS-DEVICE)`, async () => {
      const opened = await devices();
      await opened.a.add(field, key, 'Old account line.');
      await flush(opened.relay);
      const { ui, release } = await heldPage(opened);
      await ui.tab(field);
      await ui.enter(field, key, 'First, saving.');
      await ui.enter(field, key, 'Second, waiting.');
      await signOut(opened.a);
      // The new connection sends its state in a hold of the semaphore, so it waits for the held write.
      const reconnecting = opened.a.connect();
      release();
      await vi.waitFor(() => expect(ui.statuses.filter(([text]) => text === 'Saved').length).toBe(2), { timeout: 4000 });
      await reconnecting;
      await settleMany(30);
      await flush(opened.relay);

      expect(ui.statuses.filter(([, error]) => error)).toEqual([]);
      expect(textOf(opened.a, field)).toContain('Old account line.');
      for (const typed of ['First, saving.', 'Second, waiting.']) {
        expect(textOf(opened.a, field)).toContain(typed);
        expect(await held(opened.b, field)).toContainEqual([key, typed]);
      }
      ui.dom.window.close();
    });
  }
});

describe('the real prompts page reports a failure as a failure, changes nothing, and a retry succeeds', () => {
  it('Sync Now whose background reply is not ok says so, and the button is ready again', async () => {
    let reply = { ok: false, error: 'Not connected' };
    const opened = await seeded(['kb']);
    const ui = await openPage(opened.a, { commands: { 'device-sync-now': async () => reply } });
    const button = ui.document.querySelector('#sync-now-btn');
    await ui.click('#sync-now-btn');
    expect(ui.lastStatus()).toEqual(['Sync failed: Not connected', true]);
    expect(button.textContent).toBe('Sync Now');
    expect(button.disabled).toBe(false);
    reply = { ok: true };
    await ui.click('#sync-now-btn');
    expect(button.textContent).toBe('Synced!');
    ui.dom.window.close();
  });

  for (const field of FIELDS) {
    it(`a ${field} Reset whose write fails is reported, every line kept on both devices and shown; the retry resets`, async () => {
      const opened = await seeded([field]);
      const ui = await openPage(opened.a);
      await ui.tab(field);
      const before = await held(opened.a, field);
      const selector = field === 'kb' ? '#reset-kb' : '#reset-prompt';
      opened.a.store.failNext = true;
      await ui.click(selector);
      await flush(opened.relay);
      expect(ui.lastStatus()).toEqual([expect.stringMatching(/^Failed to reset: /), true]);
      expect(ui.statuses.some(([text]) => text.startsWith('Reset entire'))).toBe(false);
      await holdsEverywhere(opened, ui, field, before);

      await ui.click(selector);
      expect(await held(opened.a, field)).toEqual(defaultsOf(field));
      expect(ui.lastStatus()).toEqual([expect.stringMatching(/^Reset entire /)]);
      ui.dom.window.close();
    });
  }

  for (const field of ['composition', 'action']) {
    it(`a ${field} section Reset whose write fails is reported, every line kept on both devices and shown; the retry resets`, async () => {
      const { shapes } = AT[field];
      const opened = await seeded([field]);
      const ui = await openPage(opened.a);
      const before = await held(opened.a, field);
      opened.a.store.failNext = true;
      await ui.resetSection(field, shapes);
      await flush(opened.relay);
      expect(ui.lastStatus()).toEqual([expect.stringMatching(/^Failed to reset: /), true]);
      expect(ui.statuses.some(([text]) => text.startsWith('Reset: '))).toBe(false);
      await holdsEverywhere(opened, ui, field, before);

      await ui.resetSection(field, shapes);
      await flush(opened.relay);
      expect(ui.lastStatus()[0]).toMatch(/^Reset: /);
      await holdsEverywhere(opened, ui, field, [...before.filter(([key]) => key !== shapes), ...defaultsOf(field).filter(([key]) => key === shapes)]);
      ui.dom.window.close();
    });
  }

  const backend = [
    { name: 'Compress', field: 'kb', command: 'kb-compress', selector: '#compress-kb', caption: 'Compress', working: 'Compressing the knowledge base\u2026', failed: 'Compress failed: Synthetic failure', done: 'Knowledge base compressed successfully!' },
    { name: 'Compact Now', field: 'action', command: 'action-compact-now', selector: '#action-compact-now', caption: 'Compact now', working: 'Compacting the action rules\u2026', failed: 'Compaction failed: Synthetic failure', done: 'Merged 1 rule' },
  ];
  for (const { name, field, command, selector, caption, working, failed, done } of backend) {
    // DS-NO-BUSY-UI: nothing is greyed for working.
    it(`${name} leaves its button as it was while the background works on it, and says it is working`, async () => {
      const opened = await seeded([field]);
      const answers = [];
      const ui = await openPage(opened.a, { commands: { [command]: () => new Promise((resolve) => { answers.push(resolve); }) } });
      await ui.tab(field);
      const button = ui.document.querySelector(selector);
      await ui.click(selector);
      await vi.waitFor(() => expect(answers).toHaveLength(1), { interval: 1 });
      expect(ui.lastStatus()).toEqual([working]);
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe(caption);
      // Clicked again while the first request runs: a second request, the button still as it was.
      await ui.click(selector);
      await vi.waitFor(() => expect(answers).toHaveLength(2), { interval: 1 });
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe(caption);
      answers[0]({ ok: false, error: 'Synthetic failure' });
      await vi.waitFor(() => expect(ui.lastStatus()).toEqual([failed, true]), { interval: 1 });
      answers[1]({ ok: false, error: 'Synthetic failure' });
      await vi.waitFor(() => expect(ui.statuses.filter(([text]) => text === failed)).toHaveLength(2), { interval: 1 });
      expect(button.disabled).toBe(false);
      expect(button.textContent).toBe(caption);
      ui.dom.window.close();
    });

    it(`${name} whose background reply is not ok says so, with no success shown and nothing changed; the retry succeeds`, async () => {
      const { shapes } = AT[field];
      let fail = true;
      const opened = await seeded([field]);
      const ui = await openPage(opened.a, {
        commands: {
          [command]: async () => {
            if (fail) return { ok: false, error: 'Synthetic failure' };
            await opened.a.delete(field, shapes, 'Plain line.');
            return { ok: true, applied: 1 };
          },
        },
      });
      await ui.tab(field);
      const before = await held(opened.a, field);
      await ui.click(selector);
      await flush(opened.relay);
      expect(ui.lastStatus()).toEqual([failed, true]);
      expect(ui.statuses.some(([text]) => text === done)).toBe(false);
      await holdsEverywhere(opened, ui, field, before);

      fail = false;
      await ui.click(selector);
      await flush(opened.relay);
      expect(ui.lastStatus()).toEqual([done]);
      await holdsEverywhere(opened, ui, field, without(before, [[shapes, 'Plain line.']]));
      ui.dom.window.close();
    });
  }

  it('an edit the background answers with an error (not ok) is reported, nothing changed; the next edit is saved', async () => {
    const field = 'composition';
    const { shapes } = AT[field];
    let refuse = true;
    const opened = await seeded([field]);
    const ui = await openPage(opened.a, {
      beforeStore: async (message) => {
        if (message.op !== 'write' || !refuse) return;
        refuse = false;
        message.op = 'synthetic-unknown';
      },
    });
    const before = await held(opened.a, field);
    await ui.remove(field, shapes, 'Plain line.');
    await flush(opened.relay);
    expect(ui.lastStatus()).toEqual(['Failed to save: unknown operation synthetic-unknown', true]);
    expect(ui.statuses.some(([text]) => text === 'Saved')).toBe(false);
    await holdsEverywhere(opened, ui, field, before);
    await ui.remove(field, shapes, 'Plain line.');
    await flush(opened.relay);
    await holdsEverywhere(opened, ui, field, without(before, [[shapes, 'Plain line.']]));
    ui.dom.window.close();
  });
});
