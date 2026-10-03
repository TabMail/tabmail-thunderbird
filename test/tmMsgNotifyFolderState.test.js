import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url), 'utf8');
const OFFLINE_OPS_IID = { name: 'nsIMsgOfflineOpsDatabase' };

function createExperiment({ generateUUID } = {}) {
  class EventManager {
    constructor(options) { this.options = options; }
    api() { return { addListener() {}, removeListener() {} }; }
  }
  const sandbox = {
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: {
        ExtensionAPI: class {},
        ExtensionAPIPersistent: class {
          constructor(extension) { this.extension = extension; }
        },
        EventManager,
      } };
      if (path.includes('Timer')) return { clearInterval: vi.fn(), setInterval: vi.fn(() => 1) };
      if (path.includes('MailServices')) return { MailServices: { mfn: { addListener() {}, removeListener() {} } } };
      if (path.includes('MailUtils')) return { MailUtils: {} };
      throw new Error(path);
    } },
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    Ci: {
      nsMsgMessageFlags: { IMAPDeleted: 1, Expunged: 2 },
      nsMsgFolderFlags: { Virtual: 0x20 },
      nsIMsgOfflineOpsDatabase: OFFLINE_OPS_IID,
    },
    Services: {
      uuid: {
        generateUUID: vi.fn(generateUUID
          || (() => ({ toString: () => '{0f8fad5b-d9cb-469f-a165-70867728950e}' }))),
      },
    },
  };
  const folders = new Map();
  const extension = {
    folderManager: { get: (accountId, path) => folders.get(`${accountId}:${path}`) },
    messageManager: { convert: () => ({ id: 1 }) },
  };
  vm.runInNewContext(`${source}\nglobalThis.Experiment = tmMsgNotify;`, sandbox);
  const instance = new sandbox.Experiment(extension);
  const api = instance.getAPI({ extension }).tmMsgNotify;
  return { api, folders, services: sandbox.Services };
}

function imapFolder({ props = {}, numMessages = 3, offline = () => false, setCharProperty } = {}) {
  const stored = { highestModSeq: '42', ...props };
  const info = {
    imapUidValidity: 7,
    get numMessages() {
      if (numMessages instanceof Error) throw numMessages;
      return numMessages;
    },
    getCharProperty: vi.fn(name => stored[name] || ''),
    setCharProperty: vi.fn(setCharProperty || ((name, value) => { stored[name] = value; })),
  };
  const db = {
    dBFolderInfo: info,
    QueryInterface(iid) {
      if (iid !== OFFLINE_OPS_IID) throw new Error('no interface');
      return { hasOfflineActivity: offline };
    },
  };
  return {
    folder: {
      URI: 'imap://user@example.com/INBOX',
      server: { type: 'imap' },
      getFlag: () => false,
      msgDatabase: db,
    },
    info,
    stored,
  };
}

describe('tmMsgNotify.getFolderState msgDB identity and evidence', () => {
  it('creates one incarnation token on request and returns the same token afterwards', async () => {
    const { api, folders, services } = createExperiment();
    const { folder, info, stored } = imapFolder();
    folders.set('account1:/INBOX', folder);

    const first = await api.getFolderState('account1', '/INBOX', { ensureIncarnationToken: true });
    const second = await api.getFolderState('account1', '/INBOX', { ensureIncarnationToken: true });

    expect(first).toMatchObject({
      stableUidKeys: true,
      uidValidity: 7,
      highestModSeq: '42',
      numMessages: 3,
      pendingOfflineOps: false,
      incarnationToken: '0f8fad5b-d9cb-469f-a165-70867728950e',
    });
    expect(second.incarnationToken).toBe(first.incarnationToken);
    expect(stored.tmFolderIncarnation).toBe(first.incarnationToken);
    expect(info.setCharProperty).toHaveBeenCalledOnce();
    expect(services.uuid.generateUUID).toHaveBeenCalledOnce();
  });

  it('never creates or overwrites a token without the option', async () => {
    const { api, folders } = createExperiment();
    const fresh = imapFolder();
    folders.set('account1:/A', fresh.folder);
    const existing = imapFolder({ props: { tmFolderIncarnation: 'existing-token' } });
    folders.set('account1:/B', existing.folder);

    expect((await api.getFolderState('account1', '/A')).incarnationToken).toBe('');
    expect(await api.getFolderState('account1', '/B', { ensureIncarnationToken: true }))
      .toMatchObject({ incarnationToken: 'existing-token' });
    expect(fresh.info.setCharProperty).not.toHaveBeenCalled();
    expect(existing.info.setCharProperty).not.toHaveBeenCalled();
  });

  it.each([
    ['generator throws', { generateUUID: () => { throw new Error('no uuid'); } }, {}],
    ['setter throws', {}, { setCharProperty: () => { throw new Error('read-only db'); } }],
  ])('reports no token when the %s', async (_name, experimentOptions, folderOptions) => {
    const { api, folders } = createExperiment(experimentOptions);
    const { folder } = imapFolder(folderOptions);
    folders.set('account1:/INBOX', folder);

    const state = await api.getFolderState('account1', '/INBOX', { ensureIncarnationToken: true });

    expect(state.error).toBeUndefined();
    expect(state.incarnationToken).toBe('');
    expect(state.uidValidity).toBe(7);
  });

  it.each([
    ['pending', () => true, true],
    ['none', () => false, false],
  ])('reports offline activity %s', async (_name, offline, expected) => {
    const { api, folders } = createExperiment();
    folders.set('account1:/INBOX', imapFolder({ offline }).folder);
    expect((await api.getFolderState('account1', '/INBOX')).pendingOfflineOps).toBe(expected);
  });

  it('omits unknown offline activity and an unreadable count instead of reporting false or zero', async () => {
    const { api, folders } = createExperiment();
    folders.set('account1:/INBOX', imapFolder({
      offline: () => { throw new Error('offline store unavailable'); },
      numMessages: new Error('folder info unavailable'),
    }).folder);

    const state = await api.getFolderState('account1', '/INBOX');

    expect(state.error).toBeUndefined();
    expect(state).not.toHaveProperty('pendingOfflineOps');
    expect(state).not.toHaveProperty('numMessages');
    expect(state.stableUidKeys).toBe(true);
  });

  it('reads no msgDB evidence for a non-IMAP folder', async () => {
    const { api, folders } = createExperiment();
    const { folder, info } = imapFolder();
    folders.set('account1:/Local', { ...folder, server: { type: 'none' } });

    const state = await api.getFolderState('account1', '/Local', { ensureIncarnationToken: true });

    expect(state).toMatchObject({ stableUidKeys: false });
    expect(state).not.toHaveProperty('incarnationToken');
    expect(info.setCharProperty).not.toHaveBeenCalled();
  });
});
