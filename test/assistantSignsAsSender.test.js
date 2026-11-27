/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// assistantSignsAsSender.test.js — an email the assistant writes is signed with the name of the
// identity it is sent from, never simply the first account's (#472). The sender is:
// - in a compose window, the identity that window sends from;
// - for a reply or forward the chat writes, the identity its send step opens the window with
//   (the replied or forwarded message's account, getIdentityForMessage);
// - for a new email the chat writes, the default account's default identity, which Thunderbird
//   gives a compose window opened without one (it need not be the first account);
// - for a prepared reply, the identity of the replied message's account.
// The first account here is never the sender, so a name taken from it fails every case. When no
// sending identity resolves, the request names the user "there", the placeholder getUserName
// also sends, never another identity's name.
// For the chat, the real send step then opens the window, which must send from the identity the
// body is signed as.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({ ctx: {}, calls: [] }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({ getAndClearThink: vi.fn(() => null) }));
vi.mock('../agent/modules/llm.js', () => ({ sendChat: vi.fn(), processEditResponse: raw => (raw ? JSON.parse(raw) : {}) }));
vi.mock('../agent/modules/utils.js', async importOriginal => ({
  ...(await importOriginal()),
  saveChatLog: vi.fn(),
  resolveUniqueMessageKey: async () => ({ weID: 3 }),
  safeGetFull: async () => ({ body: 'Synthetic original.' }),
  extractBodyFromParts: async () => 'Synthetic original.',
}));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserCompositionPrompt: async () => '', getUserKBPrompt: async () => '' }));
vi.mock('../agent/modules/senderFilter.js', () => ({
  getUserEmailSetCached: async () => new Set(['second@example.com']),
  readAddressFields: async ids => ids.map(() => ({ author: [{ name: '', email: 'source@example.com' }], recipients: [{ name: '', email: 'second@example.com' }], ccList: [] })),
}));
vi.mock('../agent/modules/deviceSync.js', () => ({ probeAICache: vi.fn(async () => null) }));
vi.mock('../agent/modules/idbStorage.js', () => ({ get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: async () => ({ classList: { remove() {}, add() {} } }) }));
vi.mock('../chat/modules/context.js', () => ({ ctx: shared.ctx, initFsmSession: (pid, tool) => { shared.ctx.fsmSessions[pid] = { toolName: tool }; } }));
vi.mock('../chat/modules/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
  initialiseEmailCompose: () => { shared.ctx.composeDraft = { subject: '', body: '', recipients: [], cc: [], bcc: [] }; },
  streamText: vi.fn(),
}));
vi.mock('../chat/modules/idTranslator.js', () => ({ createIsolatedContext: vi.fn() }));
vi.mock('../chat/fsm/emailCompose.js', () => ({ validateAndNormalizeRecipientSets: async p => ({ ok: true, recipients: p.recipients || [], cc: p.cc || [], bcc: p.bcc || [] }) }));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: async () => { shared.calls.push(structuredClone({ draft: shared.ctx.composeDraft })); } }));
vi.mock('../chat/tools/core.js', () => ({ executeToolsHeadless: vi.fn() }));
// What the real send step (imported actual below) needs around it.
vi.mock('../agent/modules/composeTracker.js', () => ({ trackComposeWindow: vi.fn(), consumeSendInitiated: () => true }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chatlink/modules/core.js', () => ({ isChatLinkMessage: () => false }));
vi.mock('../chatlink/modules/fsm.js', () => ({ relayFsmConfirmation: vi.fn(async () => {}) }));
vi.mock('../chatlink/modules/compose.js', () => ({
  waitForComposeReady: vi.fn(async () => ({ ok: true })),
  setComposeBody: vi.fn(async () => ({ ok: true })),
  sendComposedEmail: vi.fn(async () => ({ ok: true, mode: 'sendNow' })),
}));

import { sendChat } from '../agent/modules/llm.js';
import { runComposeEdit } from '../compose/modules/edit.js';
import { cacheReply } from '../agent/modules/replyGenerator.js';

// The first account is listed first; the second holds the sender's identities.
const ACCOUNTS = [
  { id: 'account1', identities: [{ id: 'id1', name: 'First Person', email: 'first@example.com' }] },
  { id: 'account2', identities: [
    { id: 'id2', name: 'Second Person', email: 'second@example.com' },
    { id: 'id3', name: '', email: 'alias.name@example.com' },
  ] },
];
const REPLIED = { id: 3, subject: 'Synthetic subject', author: 'source@example.com', recipients: ['second@example.com'], ccList: [], headerMessageId: 'synthetic@example.com', folder: { accountId: 'account2', path: '/INBOX' } };

let defaultAccountId;
// The identity each compose window the send step opens sends from: the one it is opened with,
// else the default account's default identity (MailAccount lists it first), as in Thunderbird.
let opened;
beforeEach(() => {
  vi.clearAllMocks();
  shared.calls.length = 0;
  Object.keys(shared.ctx).forEach(k => delete shared.ctx[k]);
  Object.assign(shared.ctx, { fsmSessions: {}, composeDraft: {}, state: '' });
  defaultAccountId = 'account1';
  opened = [];
  const identity = id => ACCOUNTS.flatMap(a => a.identities).find(i => i.id === id) ?? null;
  const open = details => {
    opened.push(details?.identityId ? identity(details.identityId) : ACCOUNTS.find(a => a.id === defaultAccountId).identities[0]);
    return { id: 100 + opened.length };
  };
  globalThis.browser = {
    accounts: {
      list: vi.fn(async () => structuredClone(ACCOUNTS)),
      get: vi.fn(async id => structuredClone(ACCOUNTS.find(a => a.id === id) ?? null)),
      getDefault: vi.fn(async () => structuredClone(ACCOUNTS.find(a => a.id === defaultAccountId))),
    },
    identities: {
      get: vi.fn(async id => structuredClone(identity(id))),
    },
    messages: { get: vi.fn(async id => (id === REPLIED.id ? structuredClone(REPLIED) : null)) },
    compose: {
      beginNew: vi.fn(async details => open(details)),
      beginReply: vi.fn(async (_id, _type, details) => open(details)),
      beginForward: vi.fn(async (_id, details) => open(details)),
      setComposeDetails: vi.fn(async () => {}),
    },
    // The user closes each window at once, so the desktop send step returns.
    tabs: { onRemoved: { addListener: cb => { setTimeout(() => cb(100 + opened.length), 0); }, removeListener: vi.fn() } },
  };
  globalThis.TabMailQuoteDetection = { splitPlainTextForQuote: text => ({ main: text, quote: '' }) };
  globalThis.requestAnimationFrame = cb => setTimeout(cb, 0);
});
afterEach(() => {
  delete globalThis.browser;
  delete globalThis.TabMailQuoteDetection;
  delete globalThis.requestAnimationFrame;
});

const EDIT = { assistant: JSON.stringify({ subject: 'Generated subject', body: 'Generated body.' }) };
const signedAs = () => sendChat.mock.calls.map(([messages]) => messages[0].user_name);

describe('an email the assistant writes is signed as its sender (#472)', () => {
  it.each([
    ['a named identity, by its name', 'id2', 'Second Person'],
    ['an identity with no name, by its address before the @', 'id3', 'alias.name'],
  ])('in a compose window that sends from %s', async (_, identityId, name) => {
    sendChat.mockResolvedValueOnce(EDIT);
    // As the compose window's edit asks (compose/background.js).
    await runComposeEdit({ body: 'Draft.', request: 'Expand', ignoreSemaphore: true, identityId });
    expect(signedAs()).toEqual([name]);
  });

  it('a new email with no identity is signed as the default account\'s default identity, not the first account\'s', async () => {
    defaultAccountId = 'account2';
    sendChat.mockResolvedValueOnce(EDIT);
    await runComposeEdit({ body: 'Draft.', request: 'Expand' });
    expect(signedAs()).toEqual(['Second Person']);
  });

  it.each([
    ['an identity that no longer exists', 'gone', () => {}],
    ['an identity lookup that fails', 'id2', () => { browser.identities.get.mockRejectedValueOnce(new Error('synthetic failure')); }],
    ['no default account', '', () => { defaultAccountId = 'none'; }],
    ['a default account with no identity', '', () => { browser.accounts.getDefault.mockResolvedValueOnce({ id: 'account3', identities: [] }); }],
    ['a default account lookup that fails', '', () => { browser.accounts.getDefault.mockRejectedValueOnce(new Error('synthetic failure')); }],
    ['an identity with neither a name nor an address', '', () => { browser.accounts.getDefault.mockResolvedValueOnce({ id: 'account3', identities: [{ id: 'id4', name: '', email: '' }] }); }],
  ])('with %s, the request names the placeholder "there", never another identity', async (_, identityId, arrange) => {
    arrange();
    sendChat.mockResolvedValueOnce(EDIT);
    await runComposeEdit({ body: 'Draft.', request: 'Expand', ignoreSemaphore: true, identityId });
    expect(signedAs()).toEqual(['there']);
  });

  it('an edit asked again for a missing body is signed as the same identity', async () => {
    sendChat.mockResolvedValueOnce({ assistant: JSON.stringify({ subject: 'Only a subject' }) }).mockResolvedValueOnce(EDIT);
    await runComposeEdit({ body: 'Draft.', request: 'Expand', ignoreSemaphore: true, identityId: 'id2' });
    expect(signedAs()).toEqual(['Second Person', 'Second Person']);
  });

  it.each(['compose', 'reply', 'forward'])('the chat\'s %s is signed as the identity its send step opens the window with', async mode => {
    // A new email goes from the default identity; a reply or forward from the message's account,
    // whatever the default is.
    defaultAccountId = mode === 'compose' ? 'account2' : 'account1';
    sendChat.mockResolvedValueOnce(EDIT);
    const tool = await import(`../chat/tools/email_${mode}.js`);
    await tool.run(
      { unique_id: 'synthetic-message', request: 'Write a synthetic note', recipients: [{ name: 'Recipient', email: 'recipient@example.com' }] },
      { callId: 'synthetic-call', agentBubble: { classList: { remove: vi.fn() }, textContent: '' } },
    );
    await vi.waitFor(() => expect(shared.calls).toHaveLength(1));
    expect(signedAs()).toEqual(['Second Person']);
    // The real send step, desktop and headless, opens the window from the draft the tool wrote:
    // the window sends from the identity the body is signed as.
    const { runStateSendEmail, runStateSendEmailHeadless } = await vi.importActual('../chat/fsm/emailCompose.js');
    for (const send of [runStateSendEmail, runStateSendEmailHeadless]) {
      opened.length = 0;
      Object.assign(shared.ctx, { activePid: 7, fsmSessions: { 7: {} }, composeDraft: structuredClone(shared.calls[0].draft) });
      await send();
      await vi.dynamicImportSettled();
      expect(opened.map(i => i.name)).toEqual(signedAs());
    }
  });

  it('a prepared reply is signed as the identity of the replied message\'s account', async () => {
    sendChat.mockResolvedValueOnce({ assistant: JSON.stringify({ body: 'Synthetic reply.' }) });
    await cacheReply('synthetic-key', structuredClone(REPLIED), { subject: 'Re: Synthetic subject' });
    expect(signedAs()).toEqual(['Second Person']);
  });
});
