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
const { readSSEStream } = _testExports;

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
