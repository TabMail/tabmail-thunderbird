/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// chatComposeSendingIdentity.test.js — the chat's send step follows the identity an email is
// sent from, never simply the first account's first identity (#472):
// - the preview of a new email shows, as From, the identity its window will send from: the
//   default account's default identity, which Thunderbird gives a window opened with none;
// - every window the desktop send step opens composes in HTML or plain text as that sending
//   identity prefers, with the draft's body staged for it to insert.
// The headless send step (ChatLink's, dormant) keeps its own format choice: its body writer
// writes plain text only. Which identity each window opens with is unchanged: a reply or forward with the replied or
// forwarded message's identity (getIdentityForMessage), a new email with none.
//
// The compose API below follows Thunderbird's own rule for the format (ext-compose.js
// openComposeWindow, nsMsgCompose::Initialize and DetermineComposeHTML): a given isPlainText
// decides; with none, the identity the window composes with decides by its composeHtml. The
// first account is never the sender and always prefers the other format, so a format or a
// From taken from it fails every case.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shared = vi.hoisted(() => ({ ctx: {}, streamed: [], relayed: [], stored: [], messageIdentity: null }));
vi.mock('../agent/modules/composeTracker.js', () => ({ trackComposeWindow: vi.fn(), consumeSendInitiated: () => true }));
vi.mock('../agent/modules/idbStorage.js', () => ({ get: vi.fn(async () => ({})), set: vi.fn(async entry => { shared.stored.push(entry); }) }));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKey: async () => 'synthetic-key',
  // The replied or forwarded message is in the second account, unless a test clears it.
  getIdentityForMessage: async () => shared.messageIdentity,
}));
vi.mock('../agent/modules/replyGenerator.js', () => ({ STORAGE_PREFIX: 'reply:', TS_PREFIX: 'replyTs:' }));
vi.mock('../agent/modules/senderFilter.js', () => ({ readAddressFields: async ids => ids.map(() => null) }));
vi.mock('../chat/modules/context.js', () => ({ ctx: shared.ctx }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/helpers.js', async importOriginal => ({
  ...(await importOriginal()),
  initialiseEmailCompose: vi.fn(),
  streamText: (_bubble, text) => shared.streamed.push(text),
}));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: async () => ({ classList: { remove() {} } }) }));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chat/fsm/core.js', () => ({ executeAgentAction: vi.fn() }));
vi.mock('../chatlink/modules/core.js', () => ({ isChatLinkMessage: () => false }));
vi.mock('../chatlink/modules/fsm.js', () => ({ relayFsmConfirmation: vi.fn(async text => { shared.relayed.push(text); }) }));
vi.mock('../chatlink/modules/compose.js', () => ({
  waitForComposeReady: vi.fn(async () => ({ ok: true })),
  setComposeBody: vi.fn(async () => ({ ok: true })),
  sendComposedEmail: vi.fn(async () => ({ ok: true, mode: 'sendNow' })),
}));

import { runStateSendEmail, runStateSendEmailPreview } from '../chat/fsm/emailCompose.js';

// The first account is listed first and is not the default; the second account is the default
// and holds the sender. `firstHtml` sets the first identity's format, the sender the opposite.
function accounts(firstHtml) {
  return [
    { id: 'account1', identities: [{ id: 'id1', name: 'First Person', email: 'first@example.com', composeHtml: firstHtml }] },
    { id: 'account2', identities: [{ id: 'id2', name: 'Second Person', email: 'second@example.com', composeHtml: !firstHtml }] },
  ];
}

let windows;
function install(firstHtml) {
  const list = accounts(firstHtml);
  const identity = id => list.flatMap(a => a.identities).find(i => i.id === id) ?? null;
  const defaultIdentity = () => list[1].identities[0];
  windows = [];
  const open = (kind, details = {}) => {
    const sendsFrom = details.identityId ? identity(details.identityId) : defaultIdentity();
    const html = details.isPlainText != null ? !details.isPlainText : sendsFrom.composeHtml;
    windows.push({ kind, identityId: details.identityId ?? null, sendsFrom: sendsFrom.id, html });
    return { id: 100 + windows.length };
  };
  globalThis.browser = {
    accounts: {
      list: vi.fn(async () => structuredClone(list)),
      getDefault: vi.fn(async () => structuredClone(list[1])),
    },
    identities: {
      get: vi.fn(async id => structuredClone(identity(id))),
    },
    messages: { get: vi.fn(async () => ({ id: 3, author: 'Source <source@example.com>', recipients: ['second@example.com'] })) },
    compose: {
      beginNew: vi.fn(async details => open('new', details)),
      beginReply: vi.fn(async (_id, _type, details) => open('reply', details)),
      beginForward: vi.fn(async (_id, details) => open('forward', details)),
      setComposeDetails: vi.fn(async () => {}),
    },
    // The user closes each window at once, so runStateSendEmail returns.
    tabs: { onRemoved: { addListener: cb => { setTimeout(() => cb(100 + windows.length), 0); }, removeListener: vi.fn() } },
  };
}

const DRAFTS = {
  new: { recipients: [{ name: 'Recipient', email: 'recipient@example.com' }], cc: [], bcc: [], subject: 'Synthetic', body: 'Body.' },
  reply: { replyToId: 3, recipients: [], cc: [], bcc: [], body: 'Body.' },
  forward: { forwardOfId: 3, recipients: [{ name: 'Recipient', email: 'recipient@example.com' }], cc: [], bcc: [], body: 'Body.' },
};

function startWith(kind) {
  Object.keys(shared.ctx).forEach(k => delete shared.ctx[k]);
  Object.assign(shared.ctx, { activePid: 7, fsmSessions: { 7: {} }, composeDraft: structuredClone(DRAFTS[kind]), state: '' });
}

beforeEach(() => {
  shared.streamed.length = 0;
  shared.relayed.length = 0;
  shared.stored.length = 0;
  shared.messageIdentity = { identityId: 'id2', name: 'Second Person', email: 'second@example.com' };
});
afterEach(() => {
  delete globalThis.browser;
});

describe('the chat\'s send step follows the sending identity (#472)', () => {
  it.each([true, false])('a new email\'s preview shows the identity its window sends from (first account HTML: %s)', async firstHtml => {
    install(firstHtml);
    startWith('new');
    await runStateSendEmailPreview();
    const from = shared.streamed[0].split('\n').find(line => line.startsWith('**From:**'));
    expect(from).toBe('**From:** Second Person <second@example.com>');
    expect(shared.relayed[0].split('\n')).toContain('From: Second Person <second@example.com>');
  });

  it('a new email\'s preview shows a sending identity with no name by its address alone', async () => {
    install(true);
    browser.accounts.getDefault.mockResolvedValue({ id: 'account2', identities: [{ id: 'id2', name: '', email: 'second@example.com', composeHtml: false }] });
    startWith('new');
    await runStateSendEmailPreview();
    const from = shared.streamed[0].split('\n').find(line => line.startsWith('**From:**'));
    expect(from).toBe('**From:** second@example.com');
    expect(shared.relayed[0].split('\n')).toContain('From: second@example.com');
  });

  it('a new email\'s preview whose sending identity cannot be read is still shown, with no From line', async () => {
    install(true);
    browser.accounts.getDefault.mockRejectedValue(new Error('accounts unavailable'));
    startWith('new');
    await runStateSendEmailPreview();
    const lines = shared.streamed[0].split('\n');
    expect(lines.some(line => line.startsWith('**From:**'))).toBe(false);
    expect(lines).toContain('**To:** Recipient <recipient@example.com>');
    const relayed = shared.relayed[0].split('\n');
    expect(relayed.some(line => line.startsWith('From:'))).toBe(false);
  });

  it.each([
    ['new', true], ['new', false], ['reply', true], ['reply', false], ['forward', true], ['forward', false],
  ])('a %s window composes in the sending identity\'s own format (first account HTML: %s)', async (kind, firstHtml) => {
    install(firstHtml);
    startWith(kind);
    await runStateSendEmail();
    await vi.dynamicImportSettled();
    expect(windows).toHaveLength(1);
    const [window] = windows;
    expect(window.kind).toBe(kind);
    // The window still opens with the identity it did: none for a new email, the message's for a
    // reply or forward. Either way the second account's identity sends.
    expect(window.identityId).toBe(kind === 'new' ? null : 'id2');
    expect(window.sendsFrom).toBe('id2');
    expect(window.html).toBe(!firstHtml);
    // The draft's body is staged for that window, whatever its format: a reply's in the reply
    // cache the window reads, a new email's or forward's under the window's tab.
    const staged = Object.assign({}, ...shared.stored);
    const entry = kind === 'reply' ? staged['reply:synthetic-key'] : staged['activePrecompose:101'];
    expect(entry).toMatchObject(kind === 'reply' ? { reply: 'Body.', directReplace: true } : { content: 'Body.', directReplace: true });
  });

  it.each(['reply', 'forward'])('a %s whose message\'s identity does not resolve opens with no identity, not an empty one', async kind => {
    install(true);
    shared.messageIdentity = null;
    startWith(kind);
    await runStateSendEmail();
    await vi.dynamicImportSettled();
    expect(windows).toHaveLength(1);
    const [window] = windows;
    // Thunderbird then sends from the default identity, in its own format.
    expect(window.identityId).toBe(null);
    expect(window.sendsFrom).toBe('id2');
    expect(window.html).toBe(false);
  });
});
