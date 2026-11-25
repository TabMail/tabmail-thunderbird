/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// emailReplyDefaults.test.js — email_reply's reply-all defaults (sender → To, the
// other recipients → Cc, the user's own addresses left out) take each mailbox's name
// and address from Thunderbird's own parse of the replied message's raw headers
// (tmHdr.getAddressFields), through the real senderFilter. The replied MessageHeader
// also carries the strings Thunderbird would give, which are never parsed.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tbMessages, withTbAddressFields } from './helpers/tbAddressParser.js';

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
let messages;
beforeEach(() => {
  vi.clearAllMocks();
  shared.calls.length = 0;
  Object.keys(shared.ctx).forEach(k => delete shared.ctx[k]);
  Object.assign(shared.ctx, { fsmSessions: {}, composeDraft: {}, state: '' });
  messages = tbMessages();
  globalThis.browser = withTbAddressFields({
    messages: { get: vi.fn(async () => repliedHeader) },
    accounts: { list: vi.fn(async () => [{ type: 'imap', identities: [{ email: 'me@example.com' }] }]) },
  }, messages);
  globalThis.TabMailQuoteDetection = { splitPlainTextForQuote: text => ({ main: text, quote: '' }) };
  globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
});
afterEach(() => {
  delete globalThis.browser;
  delete globalThis.TabMailQuoteDetection;
  delete globalThis.requestAnimationFrame;
});

async function replyDefaults(rawFrom, rawTo, rawCc) {
  repliedHeader = messages.add({ from: rawFrom, to: rawTo, cc: rawCc }, { subject: 'Synthetic subject' });
  return runReply();
}

async function runReply() {
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

it('keeps the real sender and recipients when a name begins and ends with a quote mark and holds an address', async () => {
  const { recipients, cc } = await replyDefaults(
    '"\\"x\\" <me@example.com> \\"" <bob@example.net>',
    '=?UTF-8?Q?=22y=22_<third@example.org>,_=22z=22?= <peer@example.net>',
    '"\\"w\\" <other@example.org> \\"" <c@example.net>',
  );
  expect(recipients).toEqual([{ name: '"x" <me@example.com> "', email: 'bob@example.net' }]);
  expect(cc).toEqual([
    { name: '"y" <third@example.org>, "z"', email: 'peer@example.net' },
    { name: '"w" <other@example.org> "', email: 'c@example.net' },
  ]);
});

it('leaves both defaults empty when the replied message\'s header cannot be read, and still writes the reply', async () => {
  repliedHeader = { id: 999999, subject: 'Synthetic subject', author: 'Boss <boss@example.com>', recipients: ['peer@example.net'], ccList: [] };
  expect(await runReply()).toEqual({ recipients: [], cc: [] });
  shared.calls.length = 0;
  repliedHeader = messages.add({ from: 'Boss <boss@example.com>', to: 'peer@example.net' }, { subject: 'Synthetic subject' });
  globalThis.browser.tmHdr.getAddressFields = vi.fn(async () => { throw new Error('synthetic read failure'); });
  expect(await runReply()).toEqual({ recipients: [], cc: [] });
});
