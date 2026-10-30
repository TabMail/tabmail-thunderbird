/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// DS-REFINE-QUEUE: a refine queued before a reset still runs after it. The knowledge
// base's Compress and periodic refine share one chain, as the action rules' tag learning and Compact do.
// The one asking the model while a reset happens read before it, so its result is refused at its write
// (DS-COUNTER) and nothing of it is saved; the one waiting behind it reads after the reset, asks the model
// and is saved. The real knowledgebase.js and autoUpdateUserPrompt.js on a simulated device, with a fake
// model.

import { describe, expect, it, vi } from 'vitest';
import { BulletDevice, BulletRelay, DeviceStore, PROMPT_KEYS } from './support/bulletDevices.js';

const STALE_FACT = 'Result read before the reset';
const STALE_RULE = 'Daily digests from the old newsletter';
const FRESH_FACT = 'Fresh result';
const FRESH_RULE = 'Weekly digests from the newsletter';

function gate() {
  let open;
  const promise = new Promise((resolve) => { open = resolve; });
  return { promise, open };
}

/** A device whose model call waits at the first call until `open()` and then answers the stale result, every
 * later call answering the fresh one; it counts the calls and the chat turns indexed. */
async function writerDevice(kb) {
  const stop = gate();
  const counts = { calls: 0, indexed: 0 };
  const reply = (fact, rule) => (kb ? { refined_kb: `- ${fact}` } : { assistant: JSON.stringify({ patch: `ADD\narchive\n${rule}` }) });
  const d = await new BulletDevice('A', new DeviceStore(), new BulletRelay(), {
    files: ['agent/modules/knowledgebase.js', 'agent/modules/autoUpdateUserPrompt.js', 'agent/modules/patchApplier.js'],
    stubs: {
      'agent/modules/llm.js': {
        sendChat: async () => {
          counts.calls++;
          if (counts.calls === 1) {
            await stop.promise;
            return reply(STALE_FACT, STALE_RULE);
          }
          return reply(FRESH_FACT, FRESH_RULE);
        },
        processJSONResponse: JSON.parse,
      },
      'agent/modules/chatHistoryQueue.js': { addChatToQueue: async () => '', getUnrememberedSessions: async () => [], markSessionsAsRemembered: async () => {} },
      'chat/modules/helpers.js': { formatTimestampForAgent: () => 'now', renderToPlainText: async (text) => text },
      'chat/modules/persistentChatStore.js': {
        loadTurns: async () => [1, 2, 3].flatMap((i) => [{ role: 'user', _id: `u${i}`, content: 'Question' }, { role: 'assistant', _id: `a${i}`, content: 'Answer' }]),
        loadMeta: async () => ({}),
        getTurnsAfterCursor: (turns) => turns,
        advanceCursor() {},
        saveMeta() {},
        indexTurnToFTS: async () => { counts.indexed++; },
      },
      'agent/modules/utils.js': { log() {}, normalizeUnicode: (text) => text, saveChatLog() {}, getUniqueMessageKey: async (id) => `message-${id}`, getRealSubject: async () => 'Subject' },
      'agent/modules/actionCache.js': { origKey: (key) => `original:${key}`, userPromptKey: (key) => `original-prompt:${key}` },
      'agent/modules/idbStorage.js': { get: async (key) => ({ [key]: key.startsWith('summary:') ? { subject: 'Subject', blurb: 'Blurb' } : key.startsWith('original:') ? 'archive' : '' }) },
      'agent/modules/kbReminderGenerator.js': { generateKBReminders: async () => {} },
    },
  }).start();
  d.realm.context.browser.messages = { get: async () => ({ author: 'sender@example.com' }) };
  d.realm.context.browser.runtime.sendMessage = async () => {};
  return { d, counts, open: stop.open };
}

const WRITERS = [
  { kind: 'compress', field: 'kb', run: (m) => m.knowledge.kbCompress() },
  { kind: 'periodic refine', field: 'kb', run: (m) => m.knowledge.periodicKbUpdate({ skipTimeGuard: true }), first: (m) => m.knowledge.kbCompress() },
  { kind: 'tag learning', field: 'action', run: (m) => m.action.autoUpdateUserPromptOnTag(1, 'reply') },
  { kind: 'compact', field: 'action', run: (m) => m.action.compactActionRulesNow() },
];

describe('a writer waiting behind another while a reset happens (DS-REFINE-QUEUE)', () => {
  it.each(WRITERS)('a queued $kind still runs after the reset and is saved; the one that read before it saves nothing', async ({ kind, field, run, first }) => {
    const kb = field === 'kb';
    const { d, counts, open } = await writerDevice(kb);
    const modules = {
      knowledge: d.realm.require('agent/modules/knowledgebase.js'),
      action: d.realm.require('agent/modules/autoUpdateUserPrompt.js'),
    };
    const text = () => d.store.values[PROMPT_KEYS[field]] ?? '';
    // The first writer on the chain waits at its model call; the queued one waits behind it.
    const running = (first ?? run)(modules);
    await vi.waitFor(() => expect(counts.calls).toBe(1));
    const queued = run(modules);
    await d.reset(field);
    open();
    await Promise.all([running, queued]);
    expect(counts.calls).toBe(2);
    expect(text()).not.toContain(kb ? STALE_FACT : STALE_RULE);
    expect(text()).toContain(kb ? FRESH_FACT : FRESH_RULE);
    // The periodic refine indexes the chat turns it refined: the three exchanges, once it is saved.
    if (kind === 'periodic refine') expect(counts.indexed).toBe(3);
  });
});
