/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// shownItemRemoval.test.js — a delete from the Tasks or Reminders tab removes exactly the labels the tab
// showed for the item, never re-finding it by text (DS-DISPLAYED): a copy of the same line that arrived
// since is kept; an item already removed everywhere is answered as already removed, with nothing saved and
// the change counter kept; a store that stays busy is answered with the busy error (DS-NO-BUSY-UI). The
// real prompt store and Device Sync modules, on simulated devices.

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';

const TASK = '[Task] Once 09:00 Send the weekly summary';

async function flush(relay) {
  while (await relay.deliverOldest()) { /* every pending part */ }
}

async function connected() {
  const relay = new BulletRelay();
  const a = await new BulletDevice('A', new DeviceStore(), relay, { acquireWaitMs: 5, busyReapplyMs: 20 }).start();
  const b = await new BulletDevice('B', new DeviceStore(), relay, { acquireWaitMs: 5, busyReapplyMs: 20 }).start();
  await a.connect();
  await b.connect();
  await flush(relay);
  return { relay, a, b };
}

/** The labels a tab reading `d`'s knowledge base now shows for the line `text`. */
async function shownFor(d, text) {
  const view = await d.prompts.readView('kb');
  return view.captured.filter(([, shown]) => shown === text);
}

const texts = async (d) => (await d.state('kb')).bullets.map((bullet) => bullet.text);

describe('a delete from the Tasks or Reminders tab (DS-DISPLAYED)', () => {
  it('removes the line it showed, on both devices', async () => {
    const { relay, a, b } = await connected();
    await a.add('kb', '', TASK);
    await a.add('kb', '', 'Other note');
    await flush(relay);
    const labels = await shownFor(a, TASK);
    expect(labels.length).toBeGreaterThan(0);

    expect(await a.prompts.removeShownItem('kb', 'task_del', labels)).toBeNull();
    await flush(relay);

    for (const d of [a, b]) {
      expect(await texts(d)).not.toContain(TASK);
      expect(await texts(d)).toContain('Other note');
    }
  });

  it("keeps a copy of the same line a peer added after the tab showed it: only the labels shown are deleted", async () => {
    const { relay, a, b } = await connected();
    await a.add('kb', '', TASK);
    await flush(relay);
    const labels = await shownFor(a, TASK);
    // B deletes the line and types it again: a new label with the same text, which A's tab never showed.
    await b.delete('kb', '', TASK);
    await b.add('kb', '', TASK);
    await flush(relay);
    expect(await texts(a)).toContain(TASK);

    const answer = await a.prompts.removeShownItem('kb', 'task_del', labels);
    await flush(relay);

    expect(answer).toEqual({ error: a.prompts.ALREADY_REMOVED });
    for (const d of [a, b]) expect(await texts(d)).toContain(TASK);
  });

  it('answers an item already removed everywhere as already removed, nothing saved and the counter kept', async () => {
    const { relay, a, b } = await connected();
    await a.add('kb', '', TASK);
    await flush(relay);
    const labels = await shownFor(a, TASK);
    await b.delete('kb', '', TASK);
    await flush(relay);
    const stored = a.store.values[PROMPT_KEYS.kb];
    const change = a.prompts.change;

    expect(await a.prompts.removeShownItem('kb', 'task_del', labels)).toEqual({ error: a.prompts.ALREADY_REMOVED });
    expect(a.store.values[PROMPT_KEYS.kb]).toBe(stored);
    expect(a.prompts.change).toBe(change);
  });

  it('answers the busy error when the store stays held, nothing removed', async () => {
    const { a } = await connected();
    await a.add('kb', '', TASK);
    const labels = await shownFor(a, TASK);
    let release;
    const held = a.prompts.withPromptStore(() => new Promise((resolve) => { release = resolve; }), { label: 'a stuck writer' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));

    expect(await a.prompts.removeShownItem('kb', 'task_del', labels)).toEqual({ error: a.prompts.KB_BUSY_ERROR });
    release();
    await held;
    expect(await texts(a)).toContain(TASK);
  });
});
