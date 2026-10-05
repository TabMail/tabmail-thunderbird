/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// tmHdr's bulk flag reads look each message up by WebExtension id in Thunderbird's
// MessageManager. A WebExtension id is not the message's key in its folder, so a folder lookup
// by that number can return a different message.
// getHasAttachmentBulk: a message that is gone, or whose header cannot be read, is null ("could
// not tell", never "no"). getRepliedBulk / getHasReBulk: such a message reads as false.

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../agent/experiments/tmHdr/tmHdr.sys.mjs', import.meta.url), 'utf8');

const FLAGS = { Read: 0x1, Replied: 0x2, HasRe: 0x10, Attachment: 0x10000000 };

function createExperiment(headers, messageManager = { get: vi.fn((id) => headers[id] ?? null) }) {
  const sandbox = {
    ChromeUtils: { importESModule(path) {
      if (path.includes('ExtensionCommon')) return { ExtensionCommon: { ExtensionAPI: class {} } };
      throw new Error(path);
    } },
    console: { log: vi.fn(), error: vi.fn(), warn: vi.fn() },
    Ci: { nsMsgMessageFlags: FLAGS },
    // No open 3-pane windows: a row repaint walks an empty window list.
    Services: { wm: { getEnumerator: () => ({ hasMoreElements: () => false }) } },
  };
  vm.runInNewContext(`${source}\nglobalThis.Experiment = tmHdr;`, sandbox);
  const api = new sandbox.Experiment().getAPI({ extension: { messageManager } }).tmHdr;
  return { api, messageManager, console: sandbox.console };
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

describe.each([
  ['getRepliedBulk', FLAGS.Replied],
  ['getHasReBulk', FLAGS.HasRe],
])('tmHdr.%s', (fn, flag) => {
  it('returns each message\'s flag by WebExtension id, in id order', async () => {
    const { api, messageManager } = createExperiment({
      7: { flags: 0 },
      8: { flags: flag | FLAGS.Attachment },
    });
    expect(await api[fn]([8, 7])).toEqual([true, false]);
    expect(messageManager.get.mock.calls.map(([id]) => id)).toEqual([8, 7]);
  });

  it('reads false when only other flags are set', async () => {
    const otherReplyFlag = flag === FLAGS.Replied ? FLAGS.HasRe : FLAGS.Replied;
    const { api } = createExperiment({
      11: { flags: FLAGS.Attachment },
      12: { flags: otherReplyFlag },
      13: { flags: FLAGS.Read },
      14: { flags: FLAGS.Attachment | otherReplyFlag | FLAGS.Read },
    });
    expect(await api[fn]([11, 12, 13, 14])).toEqual([false, false, false, false]);
  });

  it('reads false for a message that is gone or whose header cannot be read', async () => {
    const headers = { 7: { flags: flag } };
    const messageManager = { get: vi.fn((id) => {
      if (id === 9) throw new Error('boom');
      return headers[id] ?? null;
    }) };
    const { api } = createExperiment(headers, messageManager);
    expect(await api[fn]([5, 9, 7])).toEqual([false, false, true]);
  });

  it('reads false for every id when the extension has no message manager', async () => {
    const { api } = createExperiment({}, null);
    expect(await api[fn]([7, 8])).toEqual([false, false]);
  });

  it('returns an empty list for a non-array argument', async () => {
    const { api } = createExperiment({});
    expect(await api[fn](null)).toEqual([]);
  });
});

describe('tmHdr logging', () => {
  it('logs nothing in a shipped build when messages are gone', async () => {
    const { api, console } = createExperiment({ 7: { flags: FLAGS.Attachment } });
    expect(await api.getHasAttachmentBulk([5, 7, 6])).toEqual([null, true, null]);
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('logs nothing in a shipped build when a row is repainted for a new action', async () => {
    const hdr = { flags: 0, messageKey: 3, folder: { URI: 'imap://user@example.com/INBOX' }, setStringProperty: vi.fn() };
    const { api, console } = createExperiment({ 7: hdr });
    expect(await api.setAction(7, 'reply')).toBe(true);
    expect(hdr.setStringProperty).toHaveBeenCalledWith('tm-action', 'reply');
    expect(console.log).not.toHaveBeenCalled();
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('still warns when a header cannot be read', async () => {
    const messageManager = { get: vi.fn(() => { throw new Error('boom'); }) };
    const { api, console } = createExperiment({}, messageManager);
    expect(await api.getHasAttachmentBulk([7])).toEqual([null]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('header read failed'), 7, expect.any(Error));
  });
});
