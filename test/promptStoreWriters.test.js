/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptStoreWriters.test.js — every writer reaches the three prompt fields through withPromptStore, one
// hold of the device's prompt semaphore per brief read-change-write (R32). The knowledge base refines read
// in one hold, ask the backend with nothing held, and write in another with the change their read
// returned: a refine whose knowledge base changed meanwhile is dropped. The prompts page reads, changes and
// saves each edit in one hold. The real client side of promptStore.js runs here, against a stand-in for
// the background (support/promptStoreHost.js).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { promptStoreHost } from './support/promptStoreHost.js';

let pairCount = 3;
const host = promptStoreHost();
const RETRIES = 3;

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), normalizeUnicode: (text) => text, saveChatLog: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({ SETTINGS: { events: {}, promptSemaphore: { leaseMs: 15000, retries: 3, retryBaseDelayMs: 1, retryJitterMs: 0 } } }));
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
const { readBeforeAI, withPromptStore, writeAfterRead } = await import('../agent/modules/promptStore.js');
const { KB_CHANGED_MEANWHILE, kbCompress, kbUpdate, periodicKbUpdate } = await import('../agent/modules/knowledgebase.js');
const { editText, resetWholeField } = await import('../prompts/modules/storage.js');

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

let random;
afterEach(() => {
  random.mockRestore();
});

beforeEach(() => {
  vi.clearAllMocks();
  host.clear();
  host.text = async () => '- Stored fact';
  host.saved = async (message) => { savedWrites.add(message); };
  savedWrites.clear();
  pairCount = 3;
  // retryWithBackoff waits up to a second more at random; none here.
  random = vi.spyOn(Math, 'random').mockReturnValue(0);
  cursor.advanced = [];
});

describe('the one way to the prompt fields (withPromptStore, R32)', () => {
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

  it('tries a busy semaphore again with backoff and runs once it is free', async () => {
    const free = host.hold();
    host.acquire.mockImplementation(async (message) => {
      host.acquires.push(message);
      if (host.acquires.length === 3) free();
      if (host.holder) return { outcome: 'busy', label: host.holder.label };
      host.holder = { token: 'token late', label: message.label };
      return { outcome: 'acquired', token: 'token late' };
    });

    expect(await withPromptStore(async (store) => store.text('kb'))).toBe('- Stored fact');
    expect(host.acquires).toHaveLength(3);
  });

  it('gives up after the configured tries with a busy error, its body never run', async () => {
    host.hold('a stuck writer');
    const body = vi.fn();

    await expect(withPromptStore(body)).rejects.toMatchObject({ busy: true, message: 'the prompt store is busy (a stuck writer)' });
    expect(body).not.toHaveBeenCalled();
    expect(host.acquires).toHaveLength(RETRIES + 1);
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

  it('a hold that lost the semaphore (a lease ended, a sign-out) has every call refused', async () => {
    await expect(withPromptStore(async (store) => {
      host.signOut();
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

  it('a read while an upgrade is unsaved (R22) throws: nothing is edited against that text', async () => {
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

    // One hold to read, one to write; the periodic refine first takes one brief hold with its event's
    // generation, before it indexes any turn.
    expect(host.acquires).toHaveLength(name === 'the periodic refine' ? 3 : 2);
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

  it.each(Object.keys(refines))('%s is dropped when a sign-out lands during its backend call', async (name) => {
    sendChat.mockImplementation(async () => {
      host.signOut();
      return { refined_kb: '- Refined fact' };
    });

    await refines[name]();

    // Its write reaches the store and is refused there: the sign-out moved the change.
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

  it('a chat session whose backend call outlasted a sign-out neither indexes nor marks its sessions remembered', async () => {
    sendChat.mockImplementation(async () => {
      host.signOut();
      return { refined_kb: '- Refined fact' };
    });

    await kbUpdate([{ role: 'user', content: 'Synthetic question' }]);

    expect(host.writes).toHaveLength(1);
    expect(saved()).toEqual([]);
    expect(indexChatSession).not.toHaveBeenCalled();
    expect(markSessionsAsRemembered).not.toHaveBeenCalled();
  });

  it('a refine asked for before a sign-out and the next sign-in, waiting behind another, reads nothing and calls no backend', async () => {
    // The first refine's backend call lasts until `release`; the second is asked for meanwhile.
    let release;
    sendChat.mockImplementationOnce(async () => {
      await new Promise((resolve) => { release = resolve; });
      return { refined_kb: '- First refine' };
    });
    const first = kbUpdate([{ role: 'user', content: 'First question' }]);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const second = kbUpdate([{ role: 'user', content: 'Second question' }]);
    // Its event's generation is taken now, before it waits for the first.
    await vi.waitFor(() => expect(host.generation).toHaveBeenCalledTimes(2));
    host.signOut();
    release();
    await Promise.all([first, second]);

    expect(sendChat).toHaveBeenCalledTimes(1);
    expect(host.reads).toHaveLength(1);
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

  it('the periodic refine stops at a chunk whose write fails, the cursor where the chunk before left it', async () => {
    pairCount = 12;
    host.writeOutcome = 'unsaved';
    sendChat.mockResolvedValue({ refined_kb: '- Refined fact' });

    await periodicKbUpdate({ skipTimeGuard: true });

    expect(sendChat).toHaveBeenCalledOnce();
    expect(cursor.advanced).toEqual([]);
  });
});

describe('the prompts page', () => {
  it('reads, changes and saves each edit in one hold, against the labels of that read', async () => {
    expect(await editText('kb', (text) => `${text}\n- Added fact`)).toBe('saved');
    host.text = async () => '- Stored fact\n- Added fact';
    expect(await editText('kb', (text) => text.replace('- Stored fact\n', ''))).toBe('saved');

    expect(host.acquires).toHaveLength(2);
    expect(host.writes.map(({ captured, content, change }) => [captured, content, change])).toEqual([
      [host.reads[0], '- Stored fact\n- Added fact', 'change 0'],
      [host.reads[1], '- Added fact', 'change 1'],
    ]);
    expect(host.holder).toBeNull();
  });

  it('an edit made while another writer holds the semaphore waits, then applies to the text as that writer left it', async () => {
    const free = host.hold();
    host.text = async () => '- Stored fact\n- From the other writer';
    const acquire = host.implementation('acquire');
    host.acquire.mockImplementation(async (message) => {
      if (host.acquires.length === 2) free(); // the other writer is done before the third try
      return acquire(message);
    });
    const edit = editText('kb', (text) => `${text}\n- Added fact`);

    expect(await edit).toBe('saved');
    expect(host.acquires).toHaveLength(3);
    expect(saved().map((write) => write.content)).toEqual(['- Stored fact\n- From the other writer\n- Added fact']);
  });

  it('an edit gives up with a busy error when the semaphore stays held, nothing written', async () => {
    host.hold('a stuck writer');

    await expect(editText('kb', (text) => `${text}\n- Added fact`)).rejects.toMatchObject({ busy: true });
    expect(host.writes).toEqual([]);
  });

  it('writes nothing when what the user acted on is gone, or the edit changes nothing', async () => {
    expect(await editText('composition', () => null)).toBe('gone');
    expect(await editText('composition', (text) => text)).toBe('unchanged');
    expect(host.writes).toEqual([]);
  });

  it('resets a whole field in one hold', async () => {
    await resetWholeField('action');

    expect(host.resets).toEqual([{ command: 'prompt-store', op: 'reset', token: expect.any(String), fields: ['action'] }]);
    expect(host.holder).toBeNull();
  });
});
