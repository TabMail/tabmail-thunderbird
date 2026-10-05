import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../agent/experiments/tmMsgNotify/tmMsgNotify.sys.mjs', import.meta.url), 'utf8');

function createExperiment({ generateUUID } = {}) {
  const folders = new Map();
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
      if (path.includes('MailUtils')) return { MailUtils: {
        getExistingFolder: uri => [...folders.values()].find(folder => folder.URI === uri),
      } };
      throw new Error(path);
    } },
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    Ci: {
      nsMsgMessageFlags: { IMAPDeleted: 1, Expunged: 2 },
      nsMsgFolderFlags: { Virtual: 0x20 },
    },
    Services: {
      uuid: {
        generateUUID: vi.fn(generateUUID
          || (() => ({ toString: () => '{0f8fad5b-d9cb-469f-a165-70867728950e}' }))),
      },
    },
  };
  const extension = {
    folderManager: {
      get: (accountId, path) => folders.get(`${accountId}:${path}`),
      convert: folder => ({ accountId: 'account1', path: folder.weFolderPath }),
    },
    messageManager: { convert: () => ({ id: 1 }) },
  };
  vm.runInNewContext(`${source}\nglobalThis.Experiment = tmMsgNotify;`, sandbox);
  const instance = new sandbox.Experiment(extension);
  const api = instance.getAPI({ extension }).tmMsgNotify;
  return { api, folders, services: sandbox.Services };
}

function imapFolder({ props = {}, setCharProperty } = {}) {
  const stored = { highestModSeq: '42', ...props };
  const info = {
    imapUidValidity: 7,
    getCharProperty: vi.fn(name => stored[name] || ''),
    setCharProperty: vi.fn(setCharProperty || ((name, value) => { stored[name] = value; })),
  };
  const db = {
    dBFolderInfo: info,
    enumerateMessages: () => ({ hasMoreElements: () => false }),
  };
  return {
    folder: {
      URI: 'imap://user@example.com/INBOX',
      weFolderPath: '/INBOX',
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

  it('opens a folder scan with the stored HIGHESTMODSEQ', async () => {
    const { api, folders } = createExperiment();
    folders.set('account1:/INBOX', imapFolder().folder);

    const opened = await api.beginFolderMessageScan('imap://user@example.com/INBOX', false);

    expect(opened.error).toBeUndefined();
    expect(opened).toMatchObject({ stableUidKeys: true, uidValidity: 7, highestModSeq: '42' });
    await api.cancelFolderMessageScan(opened.token);
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

describe('tmMsgNotify.probeMessageIds', () => {
  it('reports absent and excluded ids as missing and a failed lookup as uncertain, never missing', async () => {
    const { api, folders } = createExperiment();
    const headers = new Map([
      ['live@example.com', { flags: 0 }],
      ['deleted@example.com', { flags: 1 }],
    ]);
    folders.set('account1:/F', {
      URI: 'mailbox://nobody@Local%20Folders/F',
      msgDatabase: {
        getMsgHdrForMessageID: vi.fn(id => {
          if (id === 'broken@example.com') throw new Error('summary unavailable');
          return headers.get(id) || null;
        }),
      },
    });

    const result = await api.probeMessageIds('mailbox://nobody@Local%20Folders/F',
      ['live@example.com', 'gone@example.com', 'deleted@example.com', 'broken@example.com']);

    expect(result).toEqual({
      missing: ['gone@example.com', 'deleted@example.com'],
      uncertain: ['broken@example.com'],
    });
    expect(await api.probeMessageIds('mailbox://nobody@Local%20Folders/Absent', ['live@example.com']))
      .toEqual({ missing: [], error: 'folder_not_found' });
  });
});
