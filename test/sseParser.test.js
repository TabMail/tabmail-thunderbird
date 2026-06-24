/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// TB SSE parser tests
// Verifies the SSE reader tolerates the backend's primer (large `:` comment
// line sent first to prime iOS URLSession's 512-byte initial buffer). Comments
// are valid per SSE spec and must be silently ignored.

import { describe, it, expect } from 'vitest';

// Stub browser globals BEFORE importing llm.js — config.js attaches
// storage.onChanged listeners at module load time.
globalThis.browser = {
  runtime: { getManifest: () => ({ version: '0.0.0' }) },
  storage: {
    onChanged: { addListener: () => {} },
    local: { get: async () => ({}), set: async () => {} },
    sync: { get: async () => ({}), set: async () => {} },
  },
};
globalThis.window = globalThis.window || {};

const { _testExports } = await import('../agent/modules/llm.js');
const { readSSEStream, buildConnectionLostResult } = _testExports;

// Build a Response-like object whose body.getReader() streams pre-chunked bytes.
function mockSSEResponse(chunks) {
  const encoder = new TextEncoder();
  let i = 0;
  const reader = {
    async read() {
      if (i >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: encoder.encode(chunks[i++]) };
    },
    cancel() {},
  };
  return { body: { getReader: () => reader } };
}

describe('SSE parser — primer handling', () => {
  it('ignores a large SSE comment primer and still returns the final event', async () => {
    // Matches the backend's primer format: ":" + 1500 spaces + "\n\n"
    const primer = ':' + ' '.repeat(1500) + '\n\n';
    const response = mockSSEResponse([
      primer,
      'event: keepalive\ndata: {}\n\n',
      'event: final\ndata: {"assistant":"hi"}\n\n',
    ]);
    const result = await readSSEStream(response);
    expect(result).toEqual({ assistant: 'hi' });
  });

  it('ignores primer split across multiple reads', async () => {
    const primer1 = ':' + ' '.repeat(600);
    const primer2 = ' '.repeat(900) + '\n\n';
    const response = mockSSEResponse([
      primer1,
      primer2,
      'event: final\ndata: {"ok":true}\n\n',
    ]);
    const result = await readSSEStream(response);
    expect(result).toEqual({ ok: true });
  });

  it('ignores multiple comment lines (spec: any line starting with ":")', async () => {
    const response = mockSSEResponse([
      ':first comment\n',
      ':second comment\n',
      '\n',
      'event: final\ndata: {"msg":"ok"}\n\n',
    ]);
    const result = await readSSEStream(response);
    expect(result).toEqual({ msg: 'ok' });
  });

  it('handles primer immediately followed by keepalive without blank line between', async () => {
    // Edge case: backend could theoretically merge the primer flush with the
    // first keepalive into one TCP send. Primer ends with \n\n, then keepalive.
    const primer = ':' + 'x'.repeat(1500) + '\n\n';
    const response = mockSSEResponse([
      primer + 'event: keepalive\ndata: {}\n\nevent: final\ndata: {"done":true}\n\n',
    ]);
    const result = await readSSEStream(response);
    expect(result).toEqual({ done: true });
  });
});

// Truncation / connection-lost trigger. A stream that ends without a parseable
// `final` event must REJECT (not silently resolve). sendChatCompletions catches
// this throw and returns { connection_lost: true, resume_conversation_state },
// which drives the "Connection lost. Tap to retry." resume affordance. If
// readSSEStream ever started resolving for these, the resume path would break.
describe('SSE parser — truncation / connection lost', () => {
  it('rejects when the stream ends with no final event', async () => {
    const response = mockSSEResponse([
      'event: keepalive\ndata: {}\n\n',
      'event: tool_started\ndata: {"tool_name":"search"}\n\n',
    ]);
    await expect(readSSEStream(response)).rejects.toThrow(/Connection lost/);
  });

  it('rejects when the final event JSON is cut mid-token (truncated in transit)', async () => {
    // The `final` event's data line is incomplete JSON and the stream ends —
    // JSON.parse fails, no finalResponse is set, so the stream is "lost".
    const response = mockSSEResponse([
      'event: keepalive\ndata: {}\n\n',
      'event: final\ndata: {"assistant":"here is the long ans',
    ]);
    await expect(readSSEStream(response)).rejects.toThrow();
  });

  it('still resolves a complete final even after intermediate tool events', async () => {
    // Guard the other direction: a well-formed final must NOT be misclassified
    // as a connection loss just because tool events preceded it.
    const response = mockSSEResponse([
      'event: tool_started\ndata: {"tool_name":"search"}\n\n',
      'event: final\ndata: {"assistant":"done"}\n\n',
    ]);
    const result = await readSSEStream(response);
    expect(result).toEqual({ assistant: 'done' });
  });
});

// The catch around readSSEStream wraps the throw into this resumable result, which
// drives converse.js's "Connection lost. Tap to retry." resume. The resume re-runs
// the failed round from resume_conversation_state, so it MUST be the level's own
// input state (carrying completed tool rounds), not dropped.
describe('buildConnectionLostResult — resumable wrapping', () => {
  it('surfaces the request level input conversation_state as the resume checkpoint', () => {
    const state = { harmony_messages: [{ role: 'tool', content: '{}' }], current_round: 2 };
    const result = buildConnectionLostResult({ messages: [], conversation_state: state }, new Error('boom'));
    expect(result.connection_lost).toBe(true);
    expect(result.resume_conversation_state).toBe(state);
    expect(result.err).toContain('boom');
  });

  it('resume_conversation_state is null on the first round (no saved state yet)', () => {
    // Truncation before any tool round: nothing to resume from → restart fallback.
    const result = buildConnectionLostResult({ messages: [] }, new Error('cut'));
    expect(result.connection_lost).toBe(true);
    expect(result.resume_conversation_state).toBeNull();
  });

  it('tolerates a non-Error throw value', () => {
    const result = buildConnectionLostResult({ conversation_state: null }, 'plain string');
    expect(result.connection_lost).toBe(true);
    expect(result.resume_conversation_state).toBeNull();
    expect(result.err).toContain('plain string');
  });
});
