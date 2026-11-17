import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { experiment } from './helpers/nativeLifecycleHarness.js';

// Accounts removed while the add-on was not watching (no accounts.onDeleted)
// are found from Thunderbird's preferences at FTS start and purged. The
// preference reads go through the real tmPrefs experiment over a fake
// preference store.

vi.mock('../agent/modules/config.js', async (importOriginal) => {
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

const PREF_INVALID = 0;
const PREF_STRING = 32;

function makeIndex(rows) {
  const store = new Map(rows);
  const sorted = () => [...store.keys()].sort();
  const inRange = (k, startKey, endKey) => k >= startKey && k < endKey;
  return {
    store,
    removed: [],
    async listMsgIdRange(startKey, endKey, afterKey, limit) {
      const keys = sorted().filter(k => inRange(k, startKey, endKey) && (afterKey == null || k > afterKey));
      return { msgIds: keys.slice(0, limit), done: keys.length <= limit };
    },
    async countMsgIdRange(startKey, endKey) {
      return { count: sorted().filter(k => inRange(k, startKey, endKey)).length };
    },
    async removeBatch(ids) {
      for (const id of ids) { if (store.delete(id)) this.removed.push(id); }
      return { removed: ids.length };
    },
  };
}

// Thunderbird's preference store for accounts, plus what removing an
// account does to it (nsMsgAccountManager::RemoveAccount: rewrite the
// account list, then clear every preference under mail.account.<key>.).
function makePrefs(accountIds) {
  const prefs = new Map();
  prefs.set('mail.accountmanager.accounts', accountIds.join(','));
  for (const id of accountIds) {
    prefs.set(`mail.account.${id}.server`, `server_${id}`);
    prefs.set(`mail.account.${id}.identities`, `id_${id}`);
  }
  return {
    prefs,
    removeAccount(id) {
      const list = prefs.get('mail.accountmanager.accounts').split(',').filter(k => k !== id);
      prefs.set('mail.accountmanager.accounts', list.join(','));
      for (const name of [...prefs.keys()]) {
        if (name.startsWith(`mail.account.${id}.`)) prefs.delete(name);
      }
    },
  };
}

function tmPrefsOver(model, { failChildList = false } = {}) {
  const x = experiment('gui/experiments/tmPrefs/tmPrefs.sys.mjs', 'tmPrefs');
  Object.assign(x.Services.prefs, {
    PREF_INVALID, PREF_STRING,
    getPrefType: name => (model.prefs.has(name) ? PREF_STRING : PREF_INVALID),
    getCharPref: name => {
      if (!model.prefs.has(name)) throw new Error('NS_ERROR_UNEXPECTED');
      return model.prefs.get(name);
    },
    getChildList: prefix => {
      if (failChildList) throw new Error('NS_ERROR_FAILURE');
      return [...model.prefs.keys()].filter(name => name.startsWith(prefix));
    },
  });
  return x.api;
}

let storage;
let purge;
let loaded;

function installBrowser(tmPrefs) {
  globalThis.browser = {
    accounts: {
      onDeleted: { addListener() {}, removeListener() {} },
      list: vi.fn(async () => loaded.map(id => ({ id }))),
    },
    tmPrefs,
    storage: {
      onChanged: { addListener() {} },
      local: {
        get: vi.fn(async key => (key in storage ? { [key]: structuredClone(storage[key]) } : {})),
        set: vi.fn(async obj => { Object.assign(storage, structuredClone(obj)); }),
      },
    },
  };
}

beforeEach(async () => {
  vi.resetModules();
  storage = {};
  loaded = [];
  installBrowser(undefined);
  purge = await import('../fts/removedAccountPurge.js');
  const coordinator = await import('../fts/operationCoordinator.js');
  coordinator._resetFtsOperationCoordinatorForTests();
});

afterEach(() => {
  purge._resetRemovedAccountPurgeForTests();
  delete globalThis.browser;
});

const ROWS = [
  ['account1:INBOX:a@example.com', 'a'],
  ['account1:Archive:b@example.com', 'b'],
  ['account10:INBOX:c@example.com', 'c'],
  ['account2:INBOX:d@example.com', 'd'],
  ['account2:Sent:e@example.com', 'e'],
  ['account3:INBOX:f@example.com', 'f'],
  ['account3:INBOX:g@example.com', 'g'],
  ['account3:Trash:h@example.com', 'h'],
];

const recordWrites = () => globalThis.browser.storage.local.set.mock.calls
  .flatMap(([obj]) => obj.fts_removed_account_purges || []);

const rowsOf = (index, id) => [...index.store.keys()].filter(k => k.startsWith(`${id}:`));

async function start(index, tmPrefs) {
  globalThis.browser.tmPrefs = tmPrefs;
  await purge.initRemovedAccountPurge(index);
  await purge._removedAccountPurgeIdleForTests();
}

describe('accounts removed without an onDeleted event', () => {
  it('an account removed while the add-on was not running leaves the index at the next start', async () => {
    const model = makePrefs(['account1', 'account10', 'account2', 'account3']);
    model.removeAccount('account3');
    loaded = ['account1', 'account10', 'account2'];
    const index = makeIndex(ROWS);

    await start(index, tmPrefsOver(model));

    expect(rowsOf(index, 'account3')).toEqual([]);
    expect(index.store.size).toBe(5);
    expect(storage.fts_removed_account_purges).toEqual([]);
    expect(purge.isRemovedAccountKey('account3:INBOX:late@example.com')).toBe(true);
  });

  it('an account Thunderbird has not loaded yet but still has in its preferences keeps every row', async () => {
    // Cold start: only account1 is loaded so far; the others still exist.
    const model = makePrefs(['account1', 'account10', 'account2', 'account3']);
    loaded = ['account1'];
    const index = makeIndex(ROWS);

    await start(index, tmPrefsOver(model));

    expect(index.removed).toEqual([]);
    expect(index.store.size).toBe(ROWS.length);
    expect(storage.fts_removed_account_purges).toBeUndefined();
  });

  it('a broken account (in the list, settings kept, not loaded) keeps every row', async () => {
    const model = makePrefs(['account1', 'account10', 'account2', 'account3']);
    loaded = ['account1', 'account10', 'account2'];
    const index = makeIndex(ROWS);

    await start(index, tmPrefsOver(model));

    expect(index.removed).toEqual([]);
  });

  it('an account left out of the list but whose settings remain keeps every row', async () => {
    const model = makePrefs(['account1', 'account10', 'account2', 'account3']);
    model.prefs.set('mail.accountmanager.accounts', 'account1,account10,account2');
    loaded = ['account1', 'account10', 'account2'];
    const index = makeIndex(ROWS);

    await start(index, tmPrefsOver(model));

    expect(index.removed).toEqual([]);
  });

  it('the settings check is per account: removing account1 never reads account10 settings as account1', async () => {
    const model = makePrefs(['account1', 'account10', 'account2']);
    model.removeAccount('account1');
    loaded = ['account10', 'account2'];
    const index = makeIndex(ROWS.filter(([k]) => !k.startsWith('account3:')));

    await start(index, tmPrefsOver(model));

    expect(rowsOf(index, 'account1')).toEqual([]);
    expect(rowsOf(index, 'account10')).toHaveLength(1);
    expect(rowsOf(index, 'account2')).toHaveLength(2);
  });

  it('account10 settings alone do not make a removed account1 look present, and account1 settings do not keep account10', async () => {
    const model = makePrefs(['account1', 'account10']);
    model.removeAccount('account10');
    loaded = ['account1'];
    const index = makeIndex(ROWS.filter(([k]) => k.startsWith('account1')));

    await start(index, tmPrefsOver(model));

    expect(rowsOf(index, 'account10')).toEqual([]);
    expect(rowsOf(index, 'account1')).toHaveLength(2);
  });

  describe('refusals remove nothing and leave the purge record untouched', () => {
    const removedModel = () => {
      const model = makePrefs(['account1', 'account10', 'account2', 'account3']);
      model.removeAccount('account3');
      return model;
    };
    // A record left by an earlier removal whose purge failed: the run must
    // keep it untouched apart from finishing that purge.
    const seedRecord = () => { storage.fts_removed_account_purges = ['account9']; };

    it('a preference read error after the index scan', async () => {
      seedRecord();
      loaded = ['account1', 'account10', 'account2'];
      const index = makeIndex(ROWS);
      const scanned = vi.spyOn(index, 'listMsgIdRange');

      await start(index, tmPrefsOver(removedModel(), { failChildList: true }));

      expect(scanned).toHaveBeenCalled();
      expect(index.removed).toEqual([]);
      expect(recordWrites()).not.toContain('account3');
      // The earlier record was only finished by the existing purge path.
      expect(storage.fts_removed_account_purges).toEqual([]);
    });

    it('an empty account list', async () => {
      seedRecord();
      const model = removedModel();
      model.prefs.set('mail.accountmanager.accounts', '');
      loaded = [];
      const index = makeIndex(ROWS);

      await start(index, tmPrefsOver(model));

      expect(index.removed).toEqual([]);
      expect(recordWrites()).not.toContain('account3');
    });

    it('a missing account list', async () => {
      const model = removedModel();
      model.prefs.delete('mail.accountmanager.accounts');
      const index = makeIndex(ROWS);

      await start(index, tmPrefsOver(model));

      expect(index.removed).toEqual([]);
      expect(storage.fts_removed_account_purges).toBeUndefined();
    });

    it('a loaded account missing from the preferences', async () => {
      const model = removedModel();
      loaded = ['account1', 'account10', 'account2', 'account7'];
      const index = makeIndex(ROWS);

      await start(index, tmPrefsOver(model));

      expect(index.removed).toEqual([]);
      expect(storage.fts_removed_account_purges).toBeUndefined();
    });

    it('accounts.list failing', async () => {
      const index = makeIndex(ROWS);
      globalThis.browser.accounts.list = vi.fn(async () => { throw new Error('not ready'); });

      await start(index, tmPrefsOver(removedModel()));

      expect(index.removed).toEqual([]);
      expect(storage.fts_removed_account_purges).toBeUndefined();
    });

    it('no preference reader at all', async () => {
      loaded = ['account1', 'account10', 'account2'];
      const index = makeIndex(ROWS);

      await start(index, undefined);

      expect(index.removed).toEqual([]);
      expect(storage.fts_removed_account_purges).toBeUndefined();
    });
  });
});

describe('tmPrefs.getAccountPrefPresence', () => {
  it('reports present, absent and the account list, matching the branch with its trailing dot', async () => {
    const model = makePrefs(['account10']);
    const api = tmPrefsOver(model);
    const state = await api.getAccountPrefPresence(['account1', 'account10']);
    expect(state).toEqual({ accountList: 'account10', accounts: { account1: 'absent', account10: 'present' } });
  });

  it('returns a null list when the preference is unset', async () => {
    const model = makePrefs([]);
    model.prefs.delete('mail.accountmanager.accounts');
    const state = await tmPrefsOver(model).getAccountPrefPresence([]);
    expect(state.accountList).toBeNull();
  });

  it('rejects on a read error instead of reporting absent', async () => {
    const api = tmPrefsOver(makePrefs(['account1']), { failChildList: true });
    await expect(api.getAccountPrefPresence(['account1'])).rejects.toThrow(/getAccountPrefPresence failed/);
  });

  it('rejects an id that could escape its branch', async () => {
    const api = tmPrefsOver(makePrefs(['account1']));
    await expect(api.getAccountPrefPresence(['account1.server'])).rejects.toThrow();
  });

  it('rejects a list preference of the wrong type', async () => {
    const x = experiment('gui/experiments/tmPrefs/tmPrefs.sys.mjs', 'tmPrefs');
    Object.assign(x.Services.prefs, {
      PREF_INVALID, PREF_STRING, getPrefType: () => 64, getCharPref() {}, getChildList: () => [],
    });
    await expect(x.api.getAccountPrefPresence([])).rejects.toThrow(/unexpected type/);
  });

  it('has no write path', () => {
    const model = makePrefs(['account1']);
    const writes = [];
    const x = experiment('gui/experiments/tmPrefs/tmPrefs.sys.mjs', 'tmPrefs');
    Object.assign(x.Services.prefs, {
      PREF_INVALID, PREF_STRING,
      getPrefType: name => (model.prefs.has(name) ? PREF_STRING : PREF_INVALID),
      getCharPref: name => model.prefs.get(name),
      getChildList: prefix => [...model.prefs.keys()].filter(n => n.startsWith(prefix)),
      setCharPref: () => writes.push('set'), clearUserPref: () => writes.push('clear'),
      setIntPref: () => writes.push('set'), setBoolPref: () => writes.push('set'),
    });
    return x.api.getAccountPrefPresence(['account1', 'account2']).then(() => expect(writes).toEqual([]));
  });
});
