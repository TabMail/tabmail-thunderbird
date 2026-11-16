import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'acorn';

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { ftsRemovedAccountPurge: { pageKeys: 2 } },
}));
vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));

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
    // Kept until a later page start finds the range empty.
    expect(storage.fts_removed_account_purges).toEqual(['account1']);
    await nextPageStart(index);
    expect(storage.fts_removed_account_purges).toEqual([]);
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

    await nextPageStart(index);
    expect(accountRows(index, 'account1')).toEqual([]);
    expect(storage.fts_removed_account_purges).toEqual([]);
  });

  it('a purge whose rows are not all gone keeps its record', async () => {
    const index = makeIndex(ROWS);
    const realRemove = index.removeBatch.bind(index);
    index.removeBatch = async ids => realRemove(ids.slice(1));
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);

    accounts.onDeleted.fire('account1');
    await settle();
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
    await nextPageStart(index);
    expect(storage.fts_removed_account_purges).toEqual([]);
    expect(index.store.size).toBe(2);
  });

  it('a row written back after the in-page purge is removed at the next page start', async () => {
    const index = makeIndex(ROWS);
    const realCount = index.countMsgIdRange.bind(index);
    let wroteBack = false;
    index.countMsgIdRange = async (startKey, endKey) => {
      const result = await realCount(startKey, endKey);
      if (!wroteBack && startKey === 'account1:') {
        wroteBack = true;
        // An indexer batch read before the removal lands after the check.
        index.store.set('account1:INBOX:late@example.com', 'late invoice');
      }
      return result;
    };
    purge.setupRemovedAccountPurgeListeners();
    await purge.initRemovedAccountPurge(index);
    accounts.onDeleted.fire('account1');
    await settle();
    expect(accountRows(index, 'account1')).toEqual(['account1:INBOX:late@example.com']);

    await nextPageStart(index);
    expect(accountRows(index, 'account1')).toEqual([]);
    expect(storage.fts_removed_account_purges).toEqual([]);
    expect(index.store.size).toBe(3);
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

  it('is started by FTS engine initialization', () => {
    const source = read('../fts/engine.js');
    expect(source).toMatch(/initRemovedAccountPurge\(ftsSearch\)/);
  });
});
