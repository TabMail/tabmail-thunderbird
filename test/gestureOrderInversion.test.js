/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// gestureOrderInversion.test.js — two gestures on the same knowledge-base line from two surfaces while the
// store is held: the older one asks first and waits, the holder releases, and the newer one asks. Whatever
// surface each comes from, they land in the order the user made them (DS-SEMAPHORE request order), so the
// line ends as the user's LAST gesture left it.

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore } from './support/bulletDevices.js';

const X = 'Line the user deletes and adds back';
/** Long enough that the older gesture is still waiting when the store frees. */
const WAIT_MS = 4000;
/** How long the older gesture waits before the store frees. */
const QUEUED_MS = 300;

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

async function device() {
  const a = await new BulletDevice('A', new DeviceStore(), new BulletRelay(), { acquireWaitMs: WAIT_MS }).start();
  await a.add('kb', '', 'Other note');
  return a;
}

const texts = async (a) => (await a.state('kb')).bullets.map((bullet) => bullet.text);
const lines = (content) => content.split('\n');

/** The prompts page's delete of X: against the view it showed (DS-DISPLAYED). */
const pageDelete = (a, view) => a.prompts.withPromptStore(async (store) => (await store.write('kb', view.captured, lines(view.content).filter((line) => line !== `- ${X}`).join('\n'))).outcome, { label: 'page delete' });
/** A chat tool's add of X: reads in its own hold (DS-ADD). */
const toolAdd = (a) => a.prompts.withPromptStore(async (store) => (await store.add('kb', [{ section: '', text: X }])).outcome, { label: 'tool add' });
/** A chat tool's delete of X: reads in its own hold. */
const toolDelete = (a) => a.prompts.withPromptStore(async (store) => {
  const view = await store.read('kb');
  const next = lines(view.content).filter((line) => line !== `- ${X}`).join('\n');
  return next === view.content ? 'not found' : (await store.write('kb', view.captured, next)).outcome;
}, { label: 'tool delete' });

/** Runs `older` while the store is held and lets it wait QUEUED_MS, then frees the store and runs `newer`.
 * Returns both outcomes. */
async function olderWaits(a, older, newer) {
  const hold = gate();
  let held = false;
  const holding = a.prompts.withPromptStore(async () => { held = true; await hold.promise; }, { label: 'a refine' });
  await vi.waitFor(() => expect(held).toBe(true), { interval: 1 });
  const first = older();
  await new Promise((resolve) => setTimeout(resolve, QUEUED_MS));
  hold.open();
  await holding;
  const second = await newer();
  return [await first, second];
}

describe('two gestures on one line, the older one waiting for the held store (DS-SEMAPHORE request order)', () => {
  it('a page delete then a tool add of the same line: the line is kept', async () => {
    const a = await device();
    await a.add('kb', '', X);
    const view = await a.prompts.readView('kb');
    const outcomes = await olderWaits(a, () => pageDelete(a, view), () => toolAdd(a));
    expect(outcomes).toEqual(['saved', 'saved']);
    expect(await texts(a)).toContain(X);
  });

  it('a page delete then a tool add, in that order with the store free: the line is kept (control)', async () => {
    const a = await device();
    await a.add('kb', '', X);
    const view = await a.prompts.readView('kb');
    await pageDelete(a, view);
    await toolAdd(a);
    expect(await texts(a)).toContain(X);
  });

  it('a tool add then a tool delete of the same line: the line is gone', async () => {
    const a = await device();
    const outcomes = await olderWaits(a, () => toolAdd(a), () => toolDelete(a));
    expect(outcomes).toEqual(['saved', 'saved']);
    expect(await texts(a)).not.toContain(X);
  });

  it('a tool add then a tool delete, in that order with the store free: the line is gone (control)', async () => {
    const a = await device();
    await toolAdd(a);
    await toolDelete(a);
    expect(await texts(a)).not.toContain(X);
  });
});
