/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// thinkBuffer.test.js — Tests for agent/modules/thinkBuffer.js

import { describe, it, expect } from 'vitest';

const { setThink, getAndClearThink } = await import('../agent/modules/thinkBuffer.js');

describe('thinkBuffer', () => {
  it('starts with empty string', () => {
    // Clear any state from other tests
    getAndClearThink();
    const result = getAndClearThink();
    expect(result).toBe('');
  });

  it('stores and retrieves think text', () => {
    setThink('some thought');
    expect(getAndClearThink()).toBe('some thought');
  });

  it('clears after retrieval', () => {
    setThink('thought');
    getAndClearThink();
    expect(getAndClearThink()).toBe('');
  });

  it('handles non-string input', () => {
    setThink(123);
    expect(getAndClearThink()).toBe('');

    setThink(null);
    expect(getAndClearThink()).toBe('');

    setThink(undefined);
    expect(getAndClearThink()).toBe('');
  });

  it('overwrites previous think', () => {
    setThink('first');
    setThink('second');
    expect(getAndClearThink()).toBe('second');
  });

  it('handles empty string', () => {
    setThink('');
    expect(getAndClearThink()).toBe('');
  });
});
