/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// convertedBodyConsumers.test.js — extractBodyFromParts returns plain text, links written
// as [label](address) (#162); a consumer passes it on as is, never parsing it as HTML again.

import { JSDOM } from 'jsdom';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ full: vi.fn(), send: vi.fn(), tools: vi.fn() }));
vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: { verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {} },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({ getAndClearThink: vi.fn(() => null) }));
vi.mock('../agent/modules/utils.js', async importOriginal => ({ ...(await importOriginal()), safeGetFull: h.full }));
vi.mock('../agent/modules/llm.js', () => ({ sendChat: h.send, processEditResponse: vi.fn() }));
vi.mock('../agent/modules/promptGenerator.js', () => ({ getUserCompositionPrompt: async () => '', getUserKBPrompt: async () => '' }));
vi.mock('../chat/modules/helpers.js', () => ({ getUserName: async () => 'Example User', formatTimestampForAgent: () => 'synthetic-time' }));
vi.mock('../chat/tools/core.js', () => ({ executeToolsHeadless: h.tools }));
vi.mock('../chat/modules/idTranslator.js', () => ({ createIsolatedContext: vi.fn() }));
vi.mock('../agent/modules/deviceSync.js', () => ({ probeAICache: vi.fn(async () => null) }));
vi.mock('../agent/modules/idbStorage.js', () => ({ get: vi.fn(async () => ({})), set: vi.fn(async () => {}), remove: vi.fn(async () => {}) }));

const { buildComposeEditChat } = await import('../compose/modules/edit.js');
const { cacheReply } = await import('../agent/modules/replyGenerator.js');
const { extractBodyFromParts } = await import('../agent/modules/utils.js');
await import('../agent/modules/quoteAndSignature.js');

let savedNode;
beforeAll(() => {
  const { window } = new JSDOM('');
  savedNode = globalThis.Node;
  globalThis.Node = window.Node;
  globalThis.DOMParser = window.DOMParser;
});
afterAll(() => {
  globalThis.Node = savedNode;
  delete globalThis.DOMParser;
  vi.unstubAllGlobals();
});
beforeEach(() => vi.clearAllMocks());

async function composeEditMessage(full) {
  h.full.mockResolvedValueOnce(full);
  vi.stubGlobal('browser', { messages: { get: vi.fn(async () => ({ id: 2, subject: 'Example' })) } });
  const chat = await buildComposeEditChat({ mode: 'reply', relatedEmailId: '2', request: 'Summarize the link' });
  expect(h.full).toHaveBeenCalledTimes(1);
  expect(h.send).not.toHaveBeenCalled();
  expect(h.tools).not.toHaveBeenCalled();
  return chat;
}

describe('compose edit reads the related message as extracted', () => {
  it('keeps the whole address of a link in an HTML body', async () => {
    const chat = await composeEditMessage({ parts: [{ contentType: 'text/html', body:
      '<p>Read <a href="https://example.com/?a=1&amp;copy=2&amp;notit=3">the &lt;guide&gt;</a></p>' }] });
    expect(chat.message).toBe('Read [the \\<guide\\>](https://example.com/?a=1&copy=2&notit=3)');
  });

  it('keeps a plain-text body as written, an address in angle brackets included', async () => {
    const chat = await composeEditMessage({ parts: [{ contentType: 'text/plain', body: 'Ask Bob <bob@example.com> about Q&amp;A' }] });
    expect(chat.message).toBe('Ask Bob <bob@example.com> about Q&amp;A');
  });

  it('splits off a quote whose attribution carries a link', async () => {
    const chat = await composeEditMessage({ parts: [{ contentType: 'text/html', body:
      '<div>Read <a href="https://example.com/new">the update</a></div>'
      + '<div>On Mon, Bob &lt;<a href="mailto:bob@example.com">bob@example.com</a>&gt; wrote:</div><blockquote>old</blockquote>' }] });
    expect(chat.message.trim()).toBe('Read [the update](https://example.com/new)');
    expect(chat.quotes_section).toContain('old');
  });
});

describe('a precached reply reads the message as extracted', () => {
  it('sends the whole address of a link in an HTML body', async () => {
    h.full.mockResolvedValueOnce({ parts: [{ contentType: 'text/html', body:
      '<p>Read <a href="https://example.com/?a=1&amp;copy=2">the &lt;guide&gt;</a></p>' }] });
    h.send.mockResolvedValueOnce({ err: 'synthetic stop' });
    await cacheReply('synthetic:key', { id: 4, headerMessageId: 'r@example.com' }, {});
    expect(h.send).toHaveBeenCalledTimes(1);
    const [[systemMsg]] = h.send.mock.calls[0];
    expect(systemMsg.message).toBe('Read [the \\<guide\\>](https://example.com/?a=1&copy=2)');
  });
});

describe('extractBodyFromParts', () => {
  it('converts a text/plain part that holds an HTML document', async () => {
    const body = await extractBodyFromParts({ parts: [{ contentType: 'text/plain', body:
      '<!DOCTYPE html><html><body><p>Hi <a href="https://example.com/a">there</a></p></body></html>' }] });
    expect(body).toBe('Hi [there](https://example.com/a)');
  });
});
