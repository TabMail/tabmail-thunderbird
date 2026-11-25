/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// emailReplyDefaults.test.js — email_reply's reply-all defaults (sender → To, the
// other recipients → Cc, the user's own addresses left out) read each entry's name
// and address with Thunderbird's parser, through the real senderFilter. Each entry is
// what Thunderbird hands the add-on for the raw header (tbAuthor / tbEntries).

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tbAuthor, tbEntries, withTbAddressParser } from './helpers/tbAddressParser.js';

const shared = vi.hoisted(() => ({ ctx: {}, calls: [] }));
vi.mock('../agent/modules/llm.js', () => ({ sendChat: vi.fn(), processEditResponse: raw => (raw ? JSON.parse(raw) : {}) }));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(), saveChatLog: vi.fn(), resolveUniqueMessageKey: async () => ({ weID: 3 }),
  safeGetFull: async () => ({ body: 'Synthetic original.' }), extractBodyFromParts: async () => 'Synthetic original.', stripHtml: s => s,
}));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserCompositionPrompt: async () => '', getUserKBPrompt: async () => '' }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: async () => ({ classList: { remove() {}, add() {} } }) }));
vi.mock('../chat/modules/context.js', () => ({ ctx: shared.ctx, initFsmSession: (pid, tool) => { shared.ctx.fsmSessions[pid] = { toolName: tool }; } }));
vi.mock('../chat/modules/helpers.js', () => ({
  initialiseEmailCompose: () => { shared.ctx.composeDraft = { subject: '', body: '', recipients: [], cc: [], bcc: [] }; },
  streamText: vi.fn(), getUserName: async () => 'Synthetic', formatTimestampForAgent: () => '',
}));
vi.mock('../chat/fsm/emailCompose.js', () => ({ validateAndNormalizeRecipientSets: async p => ({ ok: true, recipients: p.recipients || [], cc: p.cc || [], bcc: p.bcc || [] }) }));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: async () => { shared.calls.push(structuredClone({ draft: shared.ctx.composeDraft })); } }));
vi.mock('../chat/tools/core.js', () => ({ executeToolsHeadless: vi.fn() }));

import { sendChat } from '../agent/modules/llm.js';

let repliedHeader;
beforeEach(() => {
  vi.clearAllMocks();
  shared.calls.length = 0;
  Object.keys(shared.ctx).forEach(k => delete shared.ctx[k]);
  Object.assign(shared.ctx, { fsmSessions: {}, composeDraft: {}, state: '' });
  globalThis.browser = withTbAddressParser({
    messages: { get: vi.fn(async () => repliedHeader) },
    accounts: { list: vi.fn(async () => [{ type: 'imap', identities: [{ email: 'me@example.com' }] }]) },
  });
  globalThis.TabMailQuoteDetection = { splitPlainTextForQuote: text => ({ main: text, quote: '' }) };
  globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
});
afterEach(() => {
  delete globalThis.browser;
  delete globalThis.TabMailQuoteDetection;
  delete globalThis.requestAnimationFrame;
});

async function replyDefaults(rawFrom, rawTo, rawCc) {
  repliedHeader = { id: 3, subject: 'Synthetic subject', author: tbAuthor(rawFrom), recipients: tbEntries(rawTo), ccList: tbEntries(rawCc) };
  sendChat.mockResolvedValueOnce({ assistant: JSON.stringify({ subject: 'Generated subject', body: 'Generated body.' }) });
  const tool = await import('../chat/tools/email_reply.js');
  await tool.run({ unique_id: 'synthetic-message', request: 'Write a synthetic note' }, { callId: 'synthetic-call', agentBubble: { classList: { remove: vi.fn() }, textContent: '' } });
  await vi.waitFor(() => expect(shared.calls).toHaveLength(1));
  const { recipients, cc } = shared.calls[0].draft;
  return { recipients, cc };
}

it('reads each entry\'s own name and address: a name holding brackets, quotes or a comma stays the name', async () => {
  const { recipients, cc } = await replyDefaults(
    '"Me <me@example.com>" <other@example.net>',
    'Me <me@example.com>, "Ann \\"x\\"" <a@example.com>',
    '=?UTF-8?Q?Ren=C3=A9?= <r@example.com>, "Doe, John" <John@Example.com>, other@example.net',
  );
  expect(recipients).toEqual([{ name: 'Me <me@example.com>', email: 'other@example.net' }]);
  expect(cc).toEqual([
    { name: 'Ann "x"', email: 'a@example.com' },
    { name: 'René', email: 'r@example.com' },
    { name: 'Doe, John', email: 'john@example.com' },
  ]);
});

it('leaves out the user\'s own address by its mailbox address only, never by a name', async () => {
  const { recipients, cc } = await replyDefaults(
    'Boss <boss@example.com>',
    '"me@example.com" <peer@example.net>, ME@example.com',
    'Team: me@example.com, c@example.net;',
  );
  expect(recipients).toEqual([{ name: 'Boss', email: 'boss@example.com' }]);
  expect(cc).toEqual([
    { name: 'me@example.com', email: 'peer@example.net' },
    { name: '', email: 'c@example.net' },
  ]);
});
