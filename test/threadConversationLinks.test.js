/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// threadConversationLinks.test.js — a thread bubble shows a link as its label (#162).
// Converted text writes links as [label](address) for the agent and search; the
// bubble is a display surface and keeps showing the text the message shows.

import { JSDOM } from 'jsdom';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const deps = vi.hoisted(() => ({ full: vi.fn() }));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false, debugLogging: false, debugMode: false, logTruncateLength: 100, getFullDiag: {},
    threadConversation: {
      source: 'folderThread', maxThreadMessages: 50, excludeCurrentMessage: false, includeBody: true,
      bodyMaxLength: null, previewLines: 2, previewLogSampleMax: 5, dedupeLogSampleMax: 5,
      excludeFutureMessages: false, futureDropLogSampleMax: 5,
    },
  },
}));
vi.mock('../agent/modules/thinkBuffer.js', () => ({ getAndClearThink: vi.fn(() => null) }));
vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));
vi.mock('../agent/modules/actionCache.js', () => ({ getActionForWeId: vi.fn(async () => null) }));
vi.mock('../agent/modules/utils.js', async importOriginal => ({
  ...(await importOriginal()),
  safeGetFull: deps.full,
  getIdentityForMessage: vi.fn(async () => null),
}));

const { fetchAndSendThreadConversation } = await import('../theme/modules/threadConversation.js');

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
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function bubbleBody(full) {
  deps.full.mockResolvedValueOnce(full);
  const sendMessage = vi.fn(async () => {});
  const earlier = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  vi.stubGlobal('browser', {
    threadMessages: {
      getThreadParents: vi.fn(),
      getThreadMessages: vi.fn(async () => ({ success: true, messages: [{ weId: 2, date: earlier, from: 'Bob <bob@example.com>' }] })),
    },
    messages: { get: vi.fn(async () => ({ author: 'Bob <bob@example.com>' })), listAttachments: vi.fn(async () => []) },
    accounts: { list: vi.fn(async () => []) },
    tabs: { sendMessage },
  });
  await fetchAndSendThreadConversation(7, 1);
  expect(sendMessage).toHaveBeenCalledTimes(1);
  const [, payload] = sendMessage.mock.calls[0];
  expect(payload.messages).toHaveLength(1);
  return payload.messages[0].body;
}

describe('thread bubble body', () => {
  it('shows a converted HTML body with each link as its label', async () => {
    const body = await bubbleBody({ parts: [{ contentType: 'text/html', body:
      '<p>Read <a href="https://example.com/a">the *post*</a> and <a href="mailto:a@example.com">a@example.com</a>.</p>' }] });
    expect(body).toBe('Read the *post* and a@example.com.');
  });

  it('shows an FTS cache body with each link as its label', async () => {
    const body = await bubbleBody({ __tmSynthetic: true, body: 'Read [the \\*post\\*](https://example.com/a) and [Q&amp;A](https://example.com/q).' });
    expect(body).toBe('Read the *post* and Q&A.');
  });

  it('shows a text/plain body as written', async () => {
    const body = await bubbleBody({ parts: [
      { contentType: 'text/plain', body: 'Written as [a](https://example.com/a) by hand' },
      { contentType: 'text/html', body: '<p>Written as <a href="https://example.com/a">a</a> by hand</p>' },
    ] });
    expect(body).toBe('Written as [a](https://example.com/a) by hand');
  });
});
