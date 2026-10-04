/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// tmHdr.getHasAttachmentBulk reads nsMsgMessageFlags.Attachment from the message database,
// resolving each header by Message-ID in its folder (never by key).

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../agent/experiments/tmHdr/tmHdr.sys.mjs', import.meta.url), 'utf8');

const FLAGS = { Replied: 0x2, HasRe: 0x10, Attachment: 0x10000000 };

function createExperiment({ inboxHeaders = {}, headersByKey = {} } = {}) {
  const inbox = {
    URI: 'imap://user@example.com/INBOX',
    GetMessageHeader: vi.fn(key => headersByKey[key] || null),
  };
  const root = { getChildNamed: name => (name === 'INBOX' ? inbox : null) };
  const findMsgIdInFolder = vi.fn((id, folder) => (folder === inbox ? inboxHeaders[id] || null : null));
  const sandbox = {
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: { ExtensionAPI: class {} } };
      if (path.includes('MailServices')) return { MailServices: {
        accounts: { getAccount: key => (key === 'account1' ? { incomingServer: { rootFolder: root } } : null) },
      } };
      if (path.includes('MailUtils')) return { MailUtils: { getExistingFolder: () => null, findMsgIdInFolder } };
      throw new Error(path);
    } },
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    Ci: { nsMsgMessageFlags: FLAGS },
  };
  vm.runInNewContext(`${source}\nglobalThis.Experiment = tmHdr;`, sandbox);
  const api = new sandbox.Experiment().getAPI({}).tmHdr;
  return { api, findMsgIdInFolder, inbox };
}

const item = messageId => ({ folderURI: 'account1://INBOX', pathStr: '/INBOX', messageId });

describe('tmHdr.getHasAttachmentBulk', () => {
  it('returns the Attachment flag of each header, in item order', async () => {
    const { api } = createExperiment({ inboxHeaders: {
      '<with@example.com>': { flags: FLAGS.Attachment | FLAGS.Replied },
      '<without@example.com>': { flags: FLAGS.HasRe | FLAGS.Replied },
    } });
    const out = await api.getHasAttachmentBulk([item('without@example.com'), item('with@example.com')]);
    expect(out).toEqual([false, true]);
  });

  it('reports false for a header that cannot be found or has no Message-ID', async () => {
    const { api } = createExperiment({ inboxHeaders: {
      '<with@example.com>': { flags: FLAGS.Attachment },
    } });
    const out = await api.getHasAttachmentBulk([
      item('missing@example.com'),
      item(''),
      { folderURI: 'account9://INBOX', pathStr: '/INBOX', messageId: 'with@example.com' },
      item('with@example.com'),
    ]);
    expect(out).toEqual([false, false, false, true]);
  });

  it('never reads a header by key, so a WebExtension id cannot name another message', async () => {
    const { api, inbox } = createExperiment({
      inboxHeaders: { '<plain@example.com>': { flags: 0 } },
      headersByKey: { 7: { flags: FLAGS.Attachment } },
    });
    const out = await api.getHasAttachmentBulk([{ ...item('plain@example.com'), key: 7 }]);
    expect(out).toEqual([false]);
    expect(inbox.GetMessageHeader).not.toHaveBeenCalled();
  });

  it('returns an empty list for a non-array argument', async () => {
    const { api } = createExperiment();
    expect(await api.getHasAttachmentBulk(null)).toEqual([]);
  });
});
