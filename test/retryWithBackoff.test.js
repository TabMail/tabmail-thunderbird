/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// retryWithBackoff.test.js — the shared retry helper: network errors, 408 and 429 are tried again with a
// growing delay up to the cap; other 4xx, 5xx and a user abort are not; a caller can name its own
// retriable errors.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));

const { retryWithBackoff } = await import('../agent/modules/retryWithBackoff.js');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** `fn` failing with each of `errors` in turn, then returning "done". */
function failing(...errors) {
  return vi.fn(async () => {
    if (errors.length > 0) throw errors.shift();
    return 'done';
  });
}

async function settle(promise) {
  const result = promise.then((value) => ({ value }), (error) => ({ error }));
  await vi.runAllTimersAsync();
  return result;
}

describe('retryWithBackoff', () => {
  it.each([
    ['a 429', new Error('Request failed: 429')],
    ['a 408', new Error('Request failed: 408')],
    ['a network error', new TypeError('Failed to fetch')],
    ['a connection timeout', new Error('Connection timeout (1000ms)')],
  ])('tries %s again and returns what the next try returns', async (_, error) => {
    const fn = failing(error);
    expect(await settle(retryWithBackoff(fn, 3, 10))).toEqual({ value: 'done' });
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a 400', new Error('Request failed: 400')],
    ['a 500', new Error('Request failed: 500')],
    ['an error that is not a network error', new Error('synthetic failure')],
  ])('does not try %s again', async (_, error) => {
    const fn = failing(error);
    expect(await settle(retryWithBackoff(fn, 3, 10))).toEqual({ error });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('gives up after the cap with the last error, each wait at least twice the one before', async () => {
    const waits = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      waits.push(delay);
      return real(callback, delay);
    });
    const last = new Error('Request failed: 429');
    const fn = failing(new Error('Request failed: 429'), new Error('Request failed: 429'), new Error('Request failed: 429'), last);

    expect(await settle(retryWithBackoff(fn, 3, 100))).toEqual({ error: last });
    expect(fn).toHaveBeenCalledTimes(4);
    expect(waits).toHaveLength(3);
    waits.forEach((wait, attempt) => expect(wait).toBeGreaterThanOrEqual(100 * 2 ** attempt));
  });

  it('stops at a user abort, before trying and when the try is aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = failing();
    expect((await settle(retryWithBackoff(fn, 3, 10, controller.signal))).error.name).toBe('AbortError');
    expect(fn).not.toHaveBeenCalled();

    const aborted = new DOMException('stopped', 'AbortError');
    const stopped = failing(aborted);
    expect(await settle(retryWithBackoff(stopped, 3, 10))).toEqual({ error: aborted });
    expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('tries again only the errors a caller names when it passes its own test', async () => {
    const busy = Object.assign(new Error('busy'), { busy: true });
    const fn = failing(busy, new Error('Request failed: 429'));
    const result = await settle(retryWithBackoff(fn, 3, 10, null, (e) => e.busy === true));
    expect(result.error.message).toBe('Request failed: 429');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['the default jitter', undefined, 1000],
    ['a jitter the caller names', 50, 50],
  ])('adds at most %s to each wait', async (_, jitterMs, most) => {
    const waits = [];
    const real = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay) => {
      waits.push(delay);
      return real(callback, delay);
    });
    vi.spyOn(Math, 'random').mockReturnValue(0.999);
    const busy = () => Object.assign(new Error('busy'), { busy: true });
    const fn = failing(busy(), busy());

    expect(await settle(retryWithBackoff(fn, 3, 10, null, (e) => e.busy === true, jitterMs))).toEqual({ value: 'done' });
    expect(waits).toHaveLength(2);
    waits.forEach((wait, attempt) => {
      expect(wait).toBeGreaterThan(10 * 2 ** attempt + most * 0.99);
      expect(wait).toBeLessThan(10 * 2 ** attempt + most);
    });
  });
});
