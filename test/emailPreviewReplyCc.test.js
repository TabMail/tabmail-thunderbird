/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// emailPreviewReplyCc.test.js — the send preview of a reply with no recipients given shows
// the original To as its Cc, minus the user's own address. Each Cc entry is a mailbox of
// Thunderbird's own parse of the original's raw To (tmHdr.getAddressFields, through the real
// senderFilter), and only a mailbox whose own address is the user's is left out. The
// MessageHeader carries the strings Thunderbird would give, which are never parsed.

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tbMessages, withTbAddressFields } from './helpers/tbAddressParser.js';

const shared = vi.hoisted(() => ({ ctx: {}, streamed: [], identity: null }));
vi.mock('../agent/modules/composeTracker.js', () => ({ trackComposeWindow: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({}));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getIdentityForMessage: async () => shared.identity,
}));
vi.mock('../chat/modules/context.js', () => ({ ctx: shared.ctx }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/helpers.js', () => ({
  initialiseEmailCompose: vi.fn(),
  streamText: (_bubble, text) => shared.streamed.push(text),
}));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: async () => ({ classList: { remove() {} } }) }));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chatlink/modules/core.js', () => ({ isChatLinkMessage: () => false }));
vi.mock('../chatlink/modules/fsm.js', () => ({ relayFsmConfirmation: vi.fn(async () => {}) }));
vi.mock('../chatlink/modules/compose.js', () => ({ waitForComposeReady: vi.fn(), setComposeBody: vi.fn(), sendComposedEmail: vi.fn() }));

import { runStateSendEmailPreview } from '../chat/fsm/emailCompose.js';

let messages;
let original;
beforeEach(() => {
  shared.streamed.length = 0;
  shared.identity = { identityId: 'id1', name: 'Me', email: 'Me@Example.com' };
  Object.keys(shared.ctx).forEach(k => delete shared.ctx[k]);
  messages = tbMessages();
  globalThis.browser = withTbAddressFields({ messages: { get: vi.fn(async () => original) } }, messages);
});
afterEach(() => {
  delete globalThis.browser;
});

async function previewCc(rawTo) {
  original = messages.add({ from: 'Sender <sender@example.net>', to: rawTo });
  Object.assign(shared.ctx, { fsmSessions: {}, composeDraft: { replyToId: original.id, recipients: [], cc: [], bcc: [], body: 'Hi' } });
  await runStateSendEmailPreview();
  return shared.streamed[0].split('\n').find(line => line.startsWith('**Cc:**'));
}

it('leaves out only the mailbox whose own address is the user\'s; an address in a name, or one that contains it, stays', async () => {
  expect(await previewCc(
    'Me <me@example.com>, "Me <me@example.com>" <other@example.net>, some@example.com, "Doe, John" <john@example.com>, "x\\" <me@example.com>" <x@example.net>',
  )).toBe('**Cc:** Me <me@example.com> <other@example.net>, some@example.com, Doe, John <john@example.com>, x" <me@example.com> <x@example.net>');
});

it('leaves out the user\'s own address whatever its case, plain or with a name', async () => {
  expect(await previewCc('ME@EXAMPLE.COM, "Doe, John" <john@example.com>, Myself <me@example.com>'))
    .toBe('**Cc:** Doe, John <john@example.com>');
});

it('leaves out a mailbox with no address', async () => {
  expect(await previewCc('John, other@example.net')).toBe('**Cc:** other@example.net');
});

it('leaves nobody out when the identity has no address', async () => {
  shared.identity = { identityId: 'id1', name: 'Me' };
  expect(await previewCc('Me <me@example.com>, other@example.net')).toBe('**Cc:** Me <me@example.com>, other@example.net');
});

it('shows no Cc when the original To holds only the user', async () => {
  expect(await previewCc('Me <me@example.com>')).toBeUndefined();
  expect(shared.streamed[0]).toContain('**To:** Sender <sender@example.net>');
});

it('shows no Cc when the original message\'s addresses cannot be read', async () => {
  original = messages.add({ from: 'Sender <sender@example.net>', to: 'other@example.net' });
  Object.assign(shared.ctx, { fsmSessions: {}, composeDraft: { replyToId: original.id, recipients: [], cc: [], bcc: [], body: 'Hi' } });
  globalThis.browser.tmHdr.getAddressFields = async ids => ids.map(() => null);
  await runStateSendEmailPreview();
  expect(shared.streamed[0]).not.toContain('**Cc:**');
  expect(shared.streamed[0]).toContain('**To:** Sender <sender@example.net>');
});

it('shows no Cc when reading the original message\'s addresses fails', async () => {
  original = messages.add({ from: 'Sender <sender@example.net>', to: 'other@example.net' });
  Object.assign(shared.ctx, { fsmSessions: {}, composeDraft: { replyToId: original.id, recipients: [], cc: [], bcc: [], body: 'Hi' } });
  globalThis.browser.tmHdr.getAddressFields = async () => { throw new Error('unavailable'); };
  await runStateSendEmailPreview();
  expect(shared.streamed[0]).not.toContain('**Cc:**');
  expect(shared.streamed[0]).toContain('**To:** Sender <sender@example.net>');
});
