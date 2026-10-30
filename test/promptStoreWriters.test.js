/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptStoreWriters.test.js — every writer reaches the three prompt fields through withPromptStore, one
// hold of the device's prompt semaphore per brief read-change-write (DS-SEMAPHORE). The knowledge base
// refines read in one hold, ask the backend with nothing held, and write in another with the change their
// read returned: a refine whose knowledge base changed meanwhile is dropped (DS-AI). The prompts page saves
// each edit in one hold against the labels it showed, never reading the text again (DS-DISPLAYED); a chat
// tool reads, changes and saves in one hold. The real client side of promptStore.js runs here, against a
// stand-in for the background (support/promptStoreHost.js).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { promptStoreHost } from './support/promptStoreHost.js';

let pairCount = 3;
const host = promptStoreHost();

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), normalizeUnicode: (text) => text, saveChatLog: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { events: {}, promptSemaphore: { leaseMs: 15000, acquireWaitMs: 20 } } }));
vi.mock('../agent/modules/llm.js', () => ({ sendChat: vi.fn() }));
vi.mock('../agent/modules/chatHistoryQueue.js', () => ({
  addChatToQueue: vi.fn(async () => 'session-1'),
  getUnrememberedSessions: vi.fn(async () => [{ id: 'session-1', timestamp: Date.now(), messages: [{ role: 'user', content: 'Synthetic question' }] }]),
  markSessionsAsRemembered: vi.fn(async () => {}),
}));
vi.mock('../chat/modules/helpers.js', () => ({ formatTimestampForAgent: () => 'now', renderToPlainText: async (text) => text }));
const cursor = { advanced: [] };
vi.mock('../chat/modules/persistentChatStore.js', () => {
  const turns = () => {
    const all = [];
    for (let i = 1; i <= pairCount; i++) all.push({ _id: `u${i}`, role: 'user', content: `Question ${i}` }, { _id: `a${i}`, role: 'assistant', content: `Answer ${i}` });
    return all;
  };
  return {
    loadTurns: vi.fn(async () => turns()),
    loadMeta: async () => ({}),
    getTurnsAfterCursor: (all) => all,
    advanceCursor: (meta, id) => cursor.advanced.push(id),
    saveMeta: () => {},
    indexTurnToFTS: async () => {},
  };
});
vi.mock('../fts/memoryIndexer.js', () => ({ indexChatSession: vi.fn(async () => {}) }));
vi.mock('../agent/modules/kbReminderGenerator.js', () => ({ generateKBReminders: vi.fn(async () => {}) }));
vi.mock('../agent/modules/actionCompactConfig.js', () => ({ readActionConfig: vi.fn(), ACTION_CONFIG_KEY: 'user_prompts:action_config' }));

globalThis.browser = {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  runtime: { sendMessage: vi.fn(async (message) => host.answer(message)) },
};

const { sendChat } = await import('../agent/modules/llm.js');
const { loadTurns } = await import('../chat/modules/persistentChatStore.js');
const { markSessionsAsRemembered } = await import('../agent/modules/chatHistoryQueue.js');
const { indexChatSession } = await import('../fts/memoryIndexer.js');
const { editText, KB_BUSY_ERROR, readBeforeAI, readView, withPromptStore, writeAfterRead } = await import('../agent/modules/promptStore.js');
const { KB_CHANGED_MEANWHILE, kbCompress, kbUpdate, periodicKbUpdate } = await import('../agent/modules/knowledgebase.js');
const { editShown, resetWholeField } = await import('../prompts/modules/storage.js');

/** The writes the host saved: those carrying the change current when they arrived. */
const savedWrites = new Set();
const saved = () => [...savedWrites];

/** A promise and the function that resolves it. */
function gate() {
  let open;
  const promise = new Promise((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

beforeEach(() => {
  vi.clearAllMocks();
  host.clear();
  host.text = async () => '- Stored fact';
  host.saved = async (message) => { savedWrites.add(message); };
  savedWrites.clear();
  pairCount = 3;
  cursor.advanced = [];
});

describe('the one way to the prompt fields (withPromptStore, DS-SEMAPHORE)', () => {
  it('acquires the semaphore, runs its body with a hold, releases it, and returns what the body returns', async () => {
    const result = await withPromptStore(async (store) => {
      expect(host.holder).not.toBeNull();
      return (await store.read('kb')).content;
    }, { label: 'synthetic writer' });

    expect(result).toBe('- Stored fact');
    expect(host.acquires).toEqual([{ command: 'prompt-store', op: 'acquire', label: 'synthetic writer' }]);
    expect(host.release).toHaveBeenCalledOnce();
    expect(host.holder).toBeNull();
  });

  it('releases the semaphore when its body throws, and rejects with that error', async () => {
    await expect(withPromptStore(async () => { throw new Error('synthetic body failure'); })).rejects.toThrow('synthetic body failure');

    expect(host.release).toHaveBeenCalledOnce();
    expect(host.holder).toBeNull();
    expect(await withPromptStore(async (store) => store.text('kb'))).toBe('- Stored fact');
  });

  it("asks the background once and rejects with a busy error when its wait in line ran out, its body never run", async () => {
    host.hold('a stuck writer');
    const body = vi.fn();

    await expect(withPromptStore(body)).rejects.toMatchObject({ busy: true, message: 'the prompt store is busy (a stuck writer)' });
    expect(body).not.toHaveBeenCalled();
    // The background does the waiting (request order): a page never retries on its own.
    expect(host.acquires).toHaveLength(1);
  });

  it('refuses a call made from inside its own body: the inner one gives up as busy, and the outer one still releases', async () => {
    const inner = vi.fn();
    await expect(withPromptStore(async () => withPromptStore(inner))).rejects.toMatchObject({ busy: true });

    expect(inner).not.toHaveBeenCalled();
    expect(host.holder).toBeNull();
  });

  it('a hold is not usable once its body has ended', async () => {
    let kept;
    await withPromptStore(async (store) => { kept = store; });

    await expect(kept.read('kb')).rejects.toThrow('the prompt store was used after its hold ended (read)');
    expect(host.read).not.toHaveBeenCalled();
  });

  it('a hold that lost the semaphore when its lease ended has every call refused (DS-LEASE)', async () => {
    await expect(withPromptStore(async (store) => {
      // The background ended the lease and the next writer took the semaphore.
      host.holder = null;
      host.hold('the next writer');
      await store.read('kb');
    })).rejects.toMatchObject({ changed: true });
    expect(host.reads).toEqual([]);
  });

  it('a write refused because the fields changed since its read throws a changed error, nothing saved', async () => {
    const read = await readBeforeAI('kb', 'synthetic refine');
    host.move();

    await expect(writeAfterRead('kb', read, '- Late', 'synthetic refine')).rejects.toMatchObject({ changed: true });
    expect(savedWrites.size).toBe(0);
  });

  it('a write after its read with nothing changed between is saved against that read\'s labels', async () => {
    const read = await readBeforeAI('kb', 'synthetic refine');

    expect(await writeAfterRead('kb', read, '- Refined', 'synthetic refine')).toEqual({ outcome: 'saved' });
    expect(host.writes).toEqual([{ command: 'prompt-store', op: 'write', token: expect.any(String), field: 'kb', captured: host.reads[0], content: '- Refined', change: 'change 0' }]);
  });

  it('a read while an upgrade is unsaved (DS-UNSAVED-UPGRADE) throws: nothing is edited against that text', async () => {
    host.unsaved = true;

    await expect(readBeforeAI('kb', 'synthetic refine')).rejects.toThrow('kb could not be saved');
    expect(await withPromptStore((store) => store.text('kb'))).toBe('- Stored fact');
  });
});

describe('the knowledge base refines', () => {
  const refines = {
    'a chat session': () => kbUpdate([{ role: 'user', content: 'Synthetic question' }]),
    'the periodic refine': () => periodicKbUpdate({ skipTimeGuard: true }),
    'a compress': () => kbCompress(),
  };

  it.each(Object.keys(refines))('%s writes the backend\'s text against the read it sent, holding nothing during the call', async (name) => {
    sendChat.mockImplementation(async ([request]) => {
      expect(request.current_user_kb_md).toBe('- Stored fact');
      expect(host.holder).toBeNull();
      return { refined_kb: '- Refined fact' };
    });

    await refines[name]();

    // One hold to read, one to write.
    expect(host.acquires).toHaveLength(2);
    expect(host.reads).toHaveLength(1);
    expect(host.writes).toEqual([{ command: 'prompt-store', op: 'write', token: expect.any(String), field: 'kb', captured: host.reads[0], content: '- Refined fact', change: 'change 0' }]);
    expect(saved()).toHaveLength(1);
    expect(host.holder).toBeNull();
  });

  it.each(Object.keys(refines))('%s saves nothing when the backend has no refined text', async (name) => {
    sendChat.mockResolvedValue({ err: 'synthetic failure' });

    await refines[name]();

    expect(host.writes).toEqual([]);
  });

  it.each(Object.keys(refines))('%s is dropped when the knowledge base changes during its backend call', async (name) => {
    sendChat.mockImplementation(async () => {
      host.move();
      return { refined_kb: '- Refined fact' };
    });

    await refines[name]();

    expect(host.writes).toHaveLength(1);
    expect(saved()).toEqual([]);
  });

  it('refines asked for together run one after another, each reading what the one before saved: none is dropped', async () => {
    let stored = '- Stored fact';
    host.text = async () => stored;
    host.saved = async (message) => {
      savedWrites.add(message);
      stored = message.content;
    };
    sendChat.mockImplementation(async ([request]) => {
      expect(host.holder).toBeNull();
      return { refined_kb: `${request.current_user_kb_md}\n- Refine ${sendChat.mock.calls.length}` };
    });

    await Promise.all([kbCompress(), periodicKbUpdate({ skipTimeGuard: true }), kbUpdate([{ role: 'user', content: 'Synthetic question' }])]);

    expect(saved().map((write) => write.content)).toEqual([
      '- Stored fact\n- Refine 1',
      '- Stored fact\n- Refine 1\n- Refine 2',
      '- Stored fact\n- Refine 1\n- Refine 2\n- Refine 3',
    ]);
  });

  it('a compress the user started tells them when the knowledge base changed meanwhile', async () => {
    sendChat.mockImplementation(async () => {
      host.move();
      return { refined_kb: '- Refined fact' };
    });

    expect(await kbCompress()).toEqual({ ok: false, error: KB_CHANGED_MEANWHILE });
  });

  it('a chat session dropped because the knowledge base changed neither indexes nor marks its sessions remembered', async () => {
    sendChat.mockImplementation(async () => {
      host.move();
      return { refined_kb: '- Refined fact' };
    });

    await kbUpdate([{ role: 'user', content: 'Synthetic question' }]);

    expect(indexChatSession).not.toHaveBeenCalled();
    expect(markSessionsAsRemembered).not.toHaveBeenCalled();
  });

  it('a chat session whose write found the semaphore busy through every try neither indexes nor marks its sessions remembered', async () => {
    sendChat.mockImplementation(async () => {
      host.hold('a stuck writer');
      return { refined_kb: '- Refined fact' };
    });

    await kbUpdate([{ role: 'user', content: 'Synthetic question' }]);

    expect(host.writes).toEqual([]);
    expect(markSessionsAsRemembered).not.toHaveBeenCalled();
  });

  it('a chat session whose save failed for another reason still marks its sessions remembered', async () => {
    host.writeOutcome = 'unsaved';
    sendChat.mockResolvedValue({ refined_kb: '- Refined fact' });

    await kbUpdate([{ role: 'user', content: 'Synthetic question' }]);

    expect(markSessionsAsRemembered).toHaveBeenCalledOnce();
  });

  it('the periodic refine stops at a chunk dropped because the knowledge base changed: no later chunk is sent, the cursor stays', async () => {
    pairCount = 12; // two chunks
    sendChat.mockImplementation(async ([request]) => {
      host.move();
      return { refined_kb: `${request.current_user_kb_md}\n- From ${request.chat_history.split('\n')[0]}` };
    });

    await periodicKbUpdate({ skipTimeGuard: true });

    expect(sendChat).toHaveBeenCalledOnce();
    expect(host.writes).toHaveLength(1);
    expect(saved()).toEqual([]);
    expect(cursor.advanced).toEqual([]);
  });

  it('the periodic refine reads again for each chunk: a change after one chunk is saved does not drop the next', async () => {
    pairCount = 12;
    sendChat.mockImplementationOnce(async () => ({ refined_kb: '- First chunk' }));
    sendChat.mockImplementation(async () => ({ refined_kb: '- Second chunk' }));
    host.saved = async (message) => {
      savedWrites.add(message);
      if (savedWrites.size === 1) host.move(); // a sync lands between the chunks
    };

    await periodicKbUpdate({ skipTimeGuard: true });

    expect(sendChat).toHaveBeenCalledTimes(2);
    expect(saved().map((write) => write.content)).toEqual(['- First chunk', '- Second chunk']);
    expect(cursor.advanced).toHaveLength(2);
    expect(host.writes.map((write) => write.change)).toEqual(['change 0', 'change 2']);
  });
});

describe('the prompts page (DS-DISPLAYED)', () => {
  it('saves each edit in one hold against the labels it showed, never reading the text again', async () => {
    const view = await readView('kb');
    expect(view.content).toBe('- Stored fact');
    host.text = async () => '- Stored fact\n- A peer fact that arrived since';

    expect(await editShown('kb', view, (text) => `${text}\n- Added fact`)).toBe('saved');

    expect(host.acquires).toHaveLength(2);
    expect(host.reads).toHaveLength(1);
    // A user edit carries no change: it is never refused because something else saved meanwhile.
    expect(host.writes).toEqual([{ command: 'prompt-store', op: 'write', token: expect.any(String), field: 'kb', captured: view.captured, content: '- Stored fact\n- Added fact' }]);
    expect(host.holder).toBeNull();
  });

  it('an edit made while another writer holds the semaphore waits in line, then saves against the labels it showed', async () => {
    const view = await readView('kb');
    const free = host.hold();
    const acquire = host.implementation('acquire');
    // The background answers the acquire once the other writer is done, as its line does.
    let answer;
    host.acquire.mockImplementation((message) => new Promise((resolve) => { answer = () => resolve(acquire(message)); }));

    const edit = editShown('kb', view, (text) => `${text}\n- Added fact`);
    await vi.waitFor(() => expect(answer).toBeDefined(), { interval: 1 });
    expect(host.writes).toEqual([]);
    free();
    answer();
    expect(await edit).toBe('saved');
    // The view's read, then the edit's one ask: the page never asks again on its own.
    expect(host.acquires).toHaveLength(2);
    expect(host.reads).toHaveLength(1);
    expect(saved().map((write) => [write.captured, write.content])).toEqual([[view.captured, '- Stored fact\n- Added fact']]);
  });

  it('an edit gives up with a busy error when the semaphore stays held, nothing written', async () => {
    const view = await readView('kb');
    host.hold('a stuck writer');

    await expect(editShown('kb', view, (text) => `${text}\n- Added fact`)).rejects.toMatchObject({ busy: true });
    expect(host.writes).toEqual([]);
  });

  it('writes nothing, and takes no hold, when what the user acted on is gone or the edit changes nothing', async () => {
    const view = await readView('composition');
    const acquires = host.acquires.length;

    expect(await editShown('composition', view, () => null)).toBe('gone');
    expect(await editShown('composition', view, (text) => text)).toBe('unchanged');
    expect(host.acquires).toHaveLength(acquires);
    expect(host.writes).toEqual([]);
  });

  it('refuses an edit of a text shown while an upgrade was unsaved (DS-UNSAVED-UPGRADE), nothing written', async () => {
    host.unsaved = true;
    const view = await readView('kb');
    expect(view.captured).toBeNull();

    await expect(editShown('kb', view, (text) => `${text}\n- Added fact`)).rejects.toThrow('kb could not be saved');
    expect(host.writes).toEqual([]);
  });

  it('resets a whole field in one hold', async () => {
    await resetWholeField('action');

    expect(host.resets).toEqual([{ command: 'prompt-store', op: 'reset', token: expect.any(String), fields: ['action'] }]);
    expect(host.holder).toBeNull();
  });
});

describe('a chat tool edit (DS-SEMAPHORE)', () => {
  it('reads, changes and saves in one hold, against the labels of that read', async () => {
    expect(await editText('kb', 'synthetic tool', (text) => ({ save: `${text}\n- Added fact` }))).toBeNull();

    expect(host.acquires).toHaveLength(1);
    expect(host.writes).toEqual([{ command: 'prompt-store', op: 'write', token: expect.any(String), field: 'kb', captured: host.reads[0], content: '- Stored fact\n- Added fact' }]);
    expect(host.holder).toBeNull();
  });

  it("returns the tool's own result with nothing saved when its edit finds nothing to change", async () => {
    expect(await editText('kb', 'synthetic tool', () => ({ error: 'not found' }))).toEqual({ error: 'not found' });
    expect(host.writes).toEqual([]);
  });

  it('answers the busy error when the semaphore stays held, nothing written', async () => {
    host.hold('a stuck writer');

    expect(await editText('kb', 'synthetic tool', (text) => ({ save: `${text}\n- Added fact` }))).toEqual({ error: KB_BUSY_ERROR });
    expect(host.writes).toEqual([]);
  });
});
