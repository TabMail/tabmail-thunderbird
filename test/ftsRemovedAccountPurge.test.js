import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

// The real config, with only the page size made small enough to page.
vi.mock('../agent/modules/config.js', async (importOriginal) => {
  // config.js subscribes to storage changes when it loads.
  globalThis.browser ??= {};
  globalThis.browser.storage ??= {};
  globalThis.browser.storage.onChanged ??= { addListener() {} };
  globalThis.browser.storage.local ??= { get: async () => ({}) };
  const real = await importOriginal();
  const SETTINGS = structuredClone(real.SETTINGS);
  SETTINGS.agentQueues.ftsRemovedAccountPurge.pageKeys = 2;
  return { ...real, SETTINGS };
});
vi.mock('../agent/modules/utils.js', () => ({ log: (...a) => { if (process.env.DBG) console.error(...a); } }));

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');

// A native index stand-in: rows keyed by msgId in BINARY order, with the
// key-range RPCs the purge uses and a plain-text search over the bodies.
function makeIndex(rows) {
  const store = new Map(rows);
  const sorted = () => [...store.keys()].sort();
  const inRange = (k, startKey, endKey) => k >= startKey && k < endKey;
  return {
    store,
    failNextList: false,
    async listMsgIdRange(startKey, endKey, afterKey, limit) {
      if (this.failNextList) { this.failNextList = false; throw new Error('helper disconnected'); }
      const keys = sorted().filter(k => inRange(k, startKey, endKey) && (afterKey == null || k > afterKey));
      return { msgIds: keys.slice(0, limit), done: keys.length <= limit };
    },
    async countMsgIdRange(startKey, endKey) {
      return { count: sorted().filter(k => inRange(k, startKey, endKey)).length };
    },
    async removeBatch(ids) {
      for (const id of ids) store.delete(id);
      return { removed: ids.length };
    },
    async search(term) {
      return sorted().filter(k => store.get(k).includes(term)).map(msgId => ({ msgId }));
    },
  };
}

function makeEvent() {
  const listeners = new Set();
  return {
    listeners,
    addListener: fn => listeners.add(fn),
    removeListener: fn => listeners.delete(fn),
    fire: (...args) => { for (const fn of listeners) fn(...args); },
  };
}

let storage;
let accounts;
let purge;

beforeEach(async () => {
  vi.resetModules();
  storage = {};
  accounts = { onDeleted: makeEvent() };
  globalThis.browser = {
    accounts,
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: vi.fn(async key => (key in storage ? { [key]: structuredClone(storage[key]) } : {})),
        set: vi.fn(async obj => { Object.assign(storage, structuredClone(obj)); }),
      },
    },
  };
  purge = await import('../fts/removedAccountPurge.js');
  const coordinator = await import('../fts/operationCoordinator.js');
  coordinator._resetFtsOperationCoordinatorForTests();
});

afterEach(() => {
  purge._resetRemovedAccountPurgeForTests();
  delete globalThis.browser;
});

const ROWS = [
  ['account1:INBOX:a@example.com', 'quarterly invoice'],
  ['account1:INBOX:b@example.com', 'invoice reminder'],
  ['account1:Archive/2020:c@example.com', 'old invoice'],
  ['account1:INBOX/sub:d@example.com', 'invoice copy'],
  ['account10:INBOX:e@example.com', 'invoice from the other account'],
  ['account2:INBOX:f@example.com', 'invoice for account two'],
  ['account0:INBOX:g@example.com', 'invoice zero'],
];

const accountRows = (index, accountId) =>
  [...index.store.keys()].filter(k => k.startsWith(`${accountId}:`));

async function settle() {
  await purge._removedAccountPurgeIdleForTests();
}

// A later background-page start: a fresh module reads the durable record.
async function nextPageStart(index) {
  purge._resetRemovedAccountPurgeForTests();
  vi.resetModules();
  purge = await import('../fts/removedAccountPurge.js');
  const coordinator = await import('../fts/operationCoordinator.js');
  coordinator._resetFtsOperationCoordinatorForTests();
  await purge.initRemovedAccountPurge(index);
}

describe('removed account purge', () => {
  it('after an account is removed, none of its messages stay indexed or appear in search', async () => {
    const index = makeIndex(ROWS);
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);

    accounts.onDeleted.fire('account1');
    await settle();

    expect(accountRows(index, 'account1')).toEqual([]);
    const hits = await index.search('invoice');
    expect(hits.some(h => h.msgId.startsWith('account1:'))).toBe(false);
    // Every other account keeps every row, including account ids that share
    // a textual prefix with the removed one.
    expect(accountRows(index, 'account10')).toHaveLength(1);
    expect(accountRows(index, 'account2')).toHaveLength(1);
    expect(accountRows(index, 'account0')).toHaveLength(1);
    expect(storage.fts_removed_account_purges).toEqual([]);
    expect(purge.isRemovedAccountKey('account1:INBOX:new@example.com')).toBe(true);
    expect(purge.isRemovedAccountKey('account10:INBOX:new@example.com')).toBe(false);
  });

  it('a removal seen before the index is ready is finished when the index starts', async () => {
    const index = makeIndex(ROWS);
    purge.setupRemovedAccountPurgeListeners();
    accounts.onDeleted.fire('account1');
    await settle();
    expect(storage.fts_removed_account_purges).toEqual(['account1']);
    expect(accountRows(index, 'account1')).toHaveLength(4);

    await nextPageStart(index);

    expect(accountRows(index, 'account1')).toEqual([]);
    expect(storage.fts_removed_account_purges).toEqual([]);
    expect(index.store.size).toBe(3);
  });

  it('a purge that fails keeps its record and the next start finishes it', async () => {
    const index = makeIndex(ROWS);
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);
    index.failNextList = true;

    accounts.onDeleted.fire('account1');
    await settle();
    expect(storage.fts_removed_account_purges).toEqual(['account1']);
    expect(accountRows(index, 'account1')).toHaveLength(4);

    await purge.initRemovedAccountPurge(index);
    expect(accountRows(index, 'account1')).toEqual([]);
    expect(storage.fts_removed_account_purges).toEqual([]);
  });

  it('a purge whose rows are not all gone keeps its record', async () => {
    const index = makeIndex(ROWS);
    const realRemove = index.removeBatch.bind(index);
    index.removeBatch = async ids => realRemove(ids.slice(1));
    storage.fts_removed_account_purges = ['account1'];
    await purge.initRemovedAccountPurge(index);
    expect(accountRows(index, 'account1').length).toBeGreaterThan(0);
    expect(storage.fts_removed_account_purges).toEqual(['account1']);
  });

  it('runs under the exclusive FTS lease and invalidates reconciliation proof', async () => {
    const coordinator = await import('../fts/operationCoordinator.js');
    const changes = [];
    const unsubscribe = coordinator.addFtsExclusiveMembershipChangeListener(e => changes.push(e.kind));
    const index = makeIndex(ROWS);
    const engine = {
      ...index,
      listMsgIdRange: index.listMsgIdRange.bind(index),
      countMsgIdRange: index.countMsgIdRange.bind(index),
      removeBatch: ids => {
        expect(coordinator.getFtsOperationState().exclusiveKind).toBe('removed_account_purge');
        return coordinator.runFtsMembershipMutation(() => index.removeBatch(ids));
      },
    };
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(engine);
    accounts.onDeleted.fire('account1');
    await settle();
    unsubscribe();
    expect(accountRows(index, 'account1')).toEqual([]);
    expect(changes).toEqual(['removed_account_purge']);
  });

  it('a removal is stored at once while another purge waits for the lease', async () => {
    const coordinator = await import('../fts/operationCoordinator.js');
    const index = makeIndex(ROWS);
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);
    const scan = await coordinator.acquireFtsExclusiveOperation('initial');

    accounts.onDeleted.fire('account1');
    await vi.waitFor(() => expect(storage.fts_removed_account_purges).toEqual(['account1']));
    accounts.onDeleted.fire('account2');
    await vi.waitFor(() => expect(storage.fts_removed_account_purges).toEqual(['account1', 'account2']));
    expect(accountRows(index, 'account1')).toHaveLength(4);

    scan.release();
    await settle();
    expect(accountRows(index, 'account1')).toEqual([]);
    expect(accountRows(index, 'account2')).toEqual([]);
    expect(storage.fts_removed_account_purges).toEqual([]);
    expect(index.store.size).toBe(2);
  });

  it('a purge that removes nothing ends, keeps its record and releases the lease', async () => {
    const coordinator = await import('../fts/operationCoordinator.js');
    const index = makeIndex(ROWS);
    index.removeBatch = async () => ({ removed: 0 });
    storage.fts_removed_account_purges = ['account1'];
    await purge.initRemovedAccountPurge(index);
    expect(storage.fts_removed_account_purges).toEqual(['account1']);
    expect(coordinator.getFtsOperationState().exclusive).toBe(false);
  });

  it('one failed purge keeps only its own record', async () => {
    const index = makeIndex(ROWS);
    const realList = index.listMsgIdRange.bind(index);
    index.listMsgIdRange = async (startKey, ...rest) => {
      if (startKey === 'account2:') throw new Error('helper disconnected');
      return realList(startKey, ...rest);
    };
    storage.fts_removed_account_purges = ['account1', 'account2', 'account0'];
    await purge.initRemovedAccountPurge(index);
    expect(storage.fts_removed_account_purges).toEqual(['account2']);
    expect(accountRows(index, 'account1')).toEqual([]);
    expect(accountRows(index, 'account0')).toEqual([]);
    expect(accountRows(index, 'account2')).toHaveLength(1);
  });

  it('the real config gives a positive page size', async () => {
    const real = await vi.importActual('../agent/modules/config.js');
    const pageKeys = real.SETTINGS.agentQueues.ftsRemovedAccountPurge.pageKeys;
    expect(Number.isInteger(pageKeys) && pageKeys > 0).toBe(true);
  });

  it('takes no FTS lease when nothing is recorded', async () => {
    const coordinator = await import('../fts/operationCoordinator.js');
    const reconcile = coordinator.tryAcquireFtsReconcileLease();
    await purge.initRemovedAccountPurge(makeIndex(ROWS));
    // An exclusive acquire would have asked the running reconcile to stop.
    expect(reconcile.cancelRequested).toBe(false);
    reconcile.release();
  });

  it('a removal during a later start record drop is not lost', async () => {
    const index = makeIndex(ROWS);
    storage.fts_removed_account_purges = ['account1'];
    purge.setupRemovedAccountPurgeListeners();
    // Hold the drop's read of the record, then report another removal.
    const realGet = browser.storage.local.get;
    let held = false;
    browser.storage.local.get = vi.fn(async (key) => {
      // Read first, then report the removal: the drop now holds a stale read.
      const value = await realGet(key);
      if (!held && accountRows(index, 'account1').length === 0) {
        held = true;
        accounts.onDeleted.fire('account2');
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      return value;
    });
    await purge.initRemovedAccountPurge(index);
    await settle();
    expect(held).toBe(true);
    expect(accountRows(index, 'account2')).toEqual([]);
    expect(storage.fts_removed_account_purges).toEqual([]);
  });

  it('a removal whose record write fails is still purged and recorded later', async () => {
    const index = makeIndex(ROWS);
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);
    const realSet = browser.storage.local.set;
    let failNext = true;
    browser.storage.local.set = vi.fn(async (obj) => {
      if (failNext) { failNext = false; throw new Error('storage busy'); }
      return realSet(obj);
    });
    const realRemove = index.removeBatch.bind(index);
    let failRemove = true;
    index.removeBatch = async (ids) => {
      if (failRemove) { failRemove = false; throw new Error('helper disconnected'); }
      return realRemove(ids);
    };

    accounts.onDeleted.fire('account1');
    await settle();
    // Not purged (removal failed) and not recorded (write failed): the
    // removal is still owed in this page.
    expect(accountRows(index, 'account1')).toHaveLength(4);
    await purge.initRemovedAccountPurge(index);
    expect(accountRows(index, 'account1')).toEqual([]);
    expect(storage.fts_removed_account_purges).toEqual([]);
  });

  it('a record write failure is retried and kept durable when the purge fails', async () => {
    const index = makeIndex(ROWS);
    index.failNextList = true;
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);
    const realSet = browser.storage.local.set;
    let failNext = true;
    browser.storage.local.set = vi.fn(async (obj) => {
      if (failNext) { failNext = false; throw new Error('storage busy'); }
      return realSet(obj);
    });
    accounts.onDeleted.fire('account1');
    await settle();
    expect(storage.fts_removed_account_purges).toEqual(['account1']);
    expect(accountRows(index, 'account1')).toHaveLength(4);
    await nextPageStart(index);
    expect(accountRows(index, 'account1')).toEqual([]);
  });

  it('a removal is purged at once when every record write fails, and recorded once storage recovers', async () => {
    const index = makeIndex(ROWS);
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);
    const realSet = browser.storage.local.set;
    let writesFail = true;
    let failedWrites = 0;
    browser.storage.local.set = vi.fn(async (obj) => {
      if (writesFail) { failedWrites++; throw new Error('storage busy'); }
      return realSet(obj);
    });
    accounts.onDeleted.fire('account1');
    await settle();
    expect(failedWrites).toBeGreaterThanOrEqual(2);
    expect(accountRows(index, 'account1')).toEqual([]);
    expect((await index.search('invoice')).some(h => h.msgId.startsWith('account1:'))).toBe(false);
    expect(accountRows(index, 'account2')).toHaveLength(1);
    writesFail = false;
    await purge.initRemovedAccountPurge(index);
    expect(storage.fts_removed_account_purges).toEqual([]);
  });

  it('a removal is purged at once when the records cannot be read', async () => {
    const index = makeIndex(ROWS);
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);
    const realGet = browser.storage.local.get;
    let readsFail = true;
    browser.storage.local.get = vi.fn(async (key) => {
      if (readsFail) throw new Error('storage unreadable');
      return realGet(key);
    });
    accounts.onDeleted.fire('account1');
    await settle();
    expect(accountRows(index, 'account1')).toEqual([]);
    expect((await index.search('invoice')).some(h => h.msgId.startsWith('account1:'))).toBe(false);
    expect(accountRows(index, 'account10')).toHaveLength(1);
    readsFail = false;
    await nextPageStart(index);
    expect(accountRows(index, 'account1')).toEqual([]);
  });

  it('ignores ids that cannot be an account key prefix', async () => {
    const index = makeIndex(ROWS);
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);
    accounts.onDeleted.fire('');
    accounts.onDeleted.fire('account1:INBOX');
    accounts.onDeleted.fire(undefined);
    await settle();
    expect(index.store.size).toBe(ROWS.length);
    expect(storage.fts_removed_account_purges).toBeUndefined();
  });

  it('registers each listener once', () => {
    purge.setupRemovedAccountPurgeListeners();
    purge.setupRemovedAccountPurgeListeners();
    expect(accounts.onDeleted.listeners.size).toBe(1);
  });

  it('is registered synchronously in the background entry point', () => {
    const source = read('../chat/background.js');
    const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
    expect(ast.body.some(node => node.type === 'ImportDeclaration' &&
      node.source.value === '../fts/removedAccountPurge.js' &&
      node.specifiers.some(spec => spec.imported?.name === 'setupRemovedAccountPurgeListeners'))).toBe(true);
    const setupCall = ast.body.findIndex(node => node.type === 'ExpressionStatement' &&
      node.expression?.type === 'CallExpression' &&
      node.expression.callee?.name === 'setupRemovedAccountPurgeListeners');
    expect(setupCall).toBeGreaterThan(-1);
    const firstAsyncStart = ast.body.findIndex(node => node.type === 'ExpressionStatement' &&
      source.slice(node.start, node.end).startsWith('browser.storage.local.get('));
    expect(firstAsyncStart).toBeGreaterThan(setupCall);
  });

});
