/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A stand-in for the background's prompt store, behind the "prompt-store" runtime message, so a test of a
// writer runs the real client side of promptStore.js (withPromptStore and the hold it gives) against it.
//
// It keeps the background's semaphore and change counter (DS-SEMAPHORE, DS-COUNTER): `acquire` is refused
// while another holds it (`busy`, or a hold of the test's own with `hold()`); never by sign-in state
// (DS-DEVICE). Every op of a hold must carry its token. A write carrying a change other than the current one
// is answered "changed"; `move()` changes it, as a saved write, a sync apply or a reset does. A write with no
// change (a user edit, DS-CAPTURE) is never refused for it. `text(field)` is what a read
// returns, `saved(message)` runs for each write saved; `reads` holds every `captured` handed out, in order;
// `writes` every write message received; `resets` and `restores` the reset and restore messages saved;
// `acquires` every acquire message. While `unsaved` is set, an upgrade is unsaved (R22): a read hands out
// no labels.

import { vi } from 'vitest';

const OPS = ['acquire', 'release', 'read', 'write', 'reset', 'restore'];

export function promptStoreHost() {
  let changes = 0;
  let tokens = 0;
  // As the background does: a hold that ended is refused as changed, and the reply says so.
  const requireHolder = (message) => {
    if (host.holder?.token !== message.token) throw Object.assign(new Error('the prompts changed while this was worked on, so nothing was saved'), { changed: true });
  };
  const host = {
    change: 'change 0',
    holder: null,
    text: async () => '',
    saved: async () => {},
    writeOutcome: 'saved',
    unsaved: false,
    reads: [],
    writes: [],
    resets: [],
    restores: [],
    acquires: [],
    acquire: vi.fn(async (message) => {
      host.acquires.push(message);
      if (host.holder) return { outcome: 'busy', label: host.holder.label };
      host.holder = { token: `token ${++tokens}`, label: message.label };
      return { outcome: 'acquired', token: host.holder.token };
    }),
    release: vi.fn(async (message) => {
      if (host.holder?.token === message.token) host.holder = null;
      return { outcome: 'released' };
    }),
    read: vi.fn(async (message) => {
      requireHolder(message);
      const content = await host.text(message.field);
      if (host.unsaved) return { content, captured: null, change: host.change };
      const captured = [[message.field, `read ${host.reads.length + 1}`]];
      host.reads.push(captured);
      return { content, captured, change: host.change };
    }),
    write: vi.fn(async (message) => {
      requireHolder(message);
      host.writes.push(message);
      if (message.change !== undefined && message.change !== host.change) return { outcome: 'changed' };
      if (host.writeOutcome === 'saved') {
        await host.saved(message);
        host.move();
      }
      return { outcome: host.writeOutcome };
    }),
    reset: vi.fn(async (message) => {
      requireHolder(message);
      host.resets.push(message);
      host.move();
      return { outcome: 'saved' };
    }),
    restore: vi.fn(async (message) => {
      requireHolder(message);
      host.restores.push(message);
      host.move();
      return { outcome: 'saved' };
    }),
    /** Something else changed the fields (an edit, a sync, a reset): an AI write of an earlier read is refused. */
    move() {
      host.change = `change ${++changes}`;
    },
    /** The test holds the semaphore, as another writer would, until it calls the function returned. */
    hold(label = 'another writer') {
      const token = `held ${++tokens}`;
      host.holder = { token, label };
      return () => {
        if (host.holder?.token === token) host.holder = null;
      };
    },
    /** The reply to `message` when it is a prompt-store message, else undefined. */
    async answer(message) {
      if (message?.command !== 'prompt-store') return undefined;
      const op = host[message.op];
      if (!OPS.includes(message.op)) return { ok: false, error: `unknown operation ${message.op}` };
      try {
        return { ok: true, ...(await op(message)) };
      } catch (e) {
        return { ok: false, error: String(e), changed: e?.changed === true, busy: e?.busy === true };
      }
    },
    /** Forgets what earlier tests did; keeps the mocks' implementations. */
    clear() {
      changes = 0;
      host.change = 'change 0';
      host.holder = null;
      host.text = async () => '';
      host.saved = async () => {};
      host.writeOutcome = 'saved';
      host.unsaved = false;
      host.reads = [];
      host.writes = [];
      host.resets = [];
      host.restores = [];
      host.acquires = [];
      // Every mock back to its own implementation, whatever a test put in its place.
      for (const name of OPS) host[name].mockReset().mockImplementation(implementations[name]);
    },
  };
  const implementations = Object.fromEntries(OPS.map((name) => [name, host[name].getMockImplementation()]));
  host.implementation = (name) => implementations[name];
  return host;
}
