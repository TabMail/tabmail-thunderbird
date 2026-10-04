/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// inbox_read prints each email's has_attachments line from the inbox context: yes, no, or
// unknown when the flag could not be read. formatMailList is the real one, so this checks
// the line the model reads.

import { describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../agent/modules/inboxContext.js', () => ({ buildInboxContext: vi.fn() }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: { inboxPageSizeDefault: 10, inboxPageSizeMax: 50 } }));
vi.mock('../chat/modules/context.js', () => ({ ctx: {} }));
vi.mock('../chat/modules/markdown.js', () => ({ renderMarkdown: vi.fn((t) => t), attachSpecialLinkListeners: vi.fn() }));

const { buildInboxContext } = await import('../agent/modules/inboxContext.js');
const { run, resetPaginationSessions } = await import('../chat/tools/inbox_read.js');

describe('inbox_read attachment line', () => {
  it('prints yes, no, or unknown from the inbox context', async () => {
    resetPaginationSessions();
    buildInboxContext.mockResolvedValue(JSON.stringify([
      { uniqueId: 'u1', subject: 'With', hasAttachments: true },
      { uniqueId: 'u2', subject: 'Without', hasAttachments: false },
      { uniqueId: 'u3', subject: 'Unread flag', hasAttachments: null },
    ]));
    const result = await run({});
    const lines = result.results
      .split(/\n(?=unique_id: )/)
      .filter((block) => block.startsWith('unique_id: '))
      .map((block) => [block.match(/unique_id: (\S*)/)[1], block.match(/has_attachments: (\w+)/)[1]]);
    expect(lines).toEqual([['u1', 'yes'], ['u2', 'no'], ['u3', 'unknown']]);
  });
});
