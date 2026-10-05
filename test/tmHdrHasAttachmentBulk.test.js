/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// tmHdr.getHasAttachmentBulk reads nsMsgMessageFlags.Attachment from the header that
// Thunderbird's MessageManager holds for each WebExtension message id. A message that is gone,
// or whose header cannot be read, is null: "could not tell", never "no".

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../agent/experiments/tmHdr/tmHdr.sys.mjs', import.meta.url), 'utf8');

const FLAGS = { Replied: 0x2, HasRe: 0x10, Attachment: 0x10000000 };

function createExperiment(headers, messageManager = { get: vi.fn((id) => headers[id] ?? null) }) {
  const sandbox = {
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: { ExtensionAPI: class {} } };
      if (path.includes('MailServices')) return { MailServices: {} };
      if (path.includes('MailUtils')) return { MailUtils: {} };
      throw new Error(path);
    } },
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    Ci: { nsMsgMessageFlags: FLAGS },
  };
  vm.runInNewContext(`${source}\nglobalThis.Experiment = tmHdr;`, sandbox);
  const api = new sandbox.Experiment().getAPI({ extension: { messageManager } }).tmHdr;
  return { api, messageManager };
}

describe('tmHdr.getHasAttachmentBulk', () => {
  it('returns each message\'s Attachment flag, in id order', async () => {
    const { api, messageManager } = createExperiment({
      7: { flags: FLAGS.Attachment | FLAGS.Replied },
      8: { flags: FLAGS.HasRe | FLAGS.Replied },
    });
    expect(await api.getHasAttachmentBulk([8, 7])).toEqual([false, true]);
    expect(messageManager.get.mock.calls.map(([id]) => id)).toEqual([8, 7]);
  });

  it('returns null for a message that is gone or whose header cannot be read', async () => {
    const headers = { 7: { flags: FLAGS.Attachment } };
    const messageManager = { get: vi.fn((id) => {
      if (id === 9) throw new Error('boom');
      return headers[id] ?? null;
    }) };
    const { api } = createExperiment(headers, messageManager);
    expect(await api.getHasAttachmentBulk([5, 9, 7])).toEqual([null, null, true]);
  });

  it('returns null for every id when the extension has no message manager', async () => {
    const { api } = createExperiment({}, null);
    expect(await api.getHasAttachmentBulk([7, 8])).toEqual([null, null]);
  });

  it('returns an empty list for a non-array argument', async () => {
    const { api } = createExperiment({});
    expect(await api.getHasAttachmentBulk(null)).toEqual([]);
  });
});
