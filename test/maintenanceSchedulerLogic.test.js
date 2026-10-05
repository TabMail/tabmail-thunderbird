/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// maintenanceSchedulerLogic.test.js — Tests for pure logic functions in fts/maintenanceScheduler.js
// Tests calculateDateRange (the weekly-window and due-type pickers of the
// deleted maintenance tick went with it in PR 3b).

import { describe, it, expect, vi } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis mocks (same pattern as maintenanceTimestamp.test.js)
// ---------------------------------------------------------------------------
globalThis.browser = {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
  alarms: {
    create: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    getAll: vi.fn(async () => []),
    onAlarm: { addListener: vi.fn(), removeListener: vi.fn() },
  },
};

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {},
}));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getUniqueMessageKeyCandidates: vi.fn(),
  headerIDToWeID: vi.fn(),
  recheckMessageInFolder: vi.fn(),
}));

const { _testExports } = await import('../fts/maintenanceScheduler.js');
const { calculateDateRange } = _testExports;

// ---------------------------------------------------------------------------
// calculateDateRange
// ---------------------------------------------------------------------------
describe('calculateDateRange', () => {
  it('returns start and end dates for days unit', () => {
    const before = new Date();
    const result = calculateDateRange(3, 'days');
    const after = new Date();

    expect(result).toHaveProperty('start');
    expect(result).toHaveProperty('end');
    expect(result.start).toBeInstanceOf(Date);
    expect(result.end).toBeInstanceOf(Date);

    // start should be approximately 3 days before end
    const diffMs = result.end.getTime() - result.start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(2.9);
    expect(diffDays).toBeLessThanOrEqual(3.1);
  });

  it('returns start and end dates for weeks unit', () => {
    const result = calculateDateRange(2, 'weeks');
    const diffMs = result.end.getTime() - result.start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThanOrEqual(13.9);
    expect(diffDays).toBeLessThanOrEqual(14.1);
  });

  it('returns start and end dates for months unit', () => {
    const result = calculateDateRange(1, 'months');
    const diffMs = result.end.getTime() - result.start.getTime();
    const diffDays = diffMs / (1000 * 60 * 60 * 24);
    // 1 month is 28-31 days
    expect(diffDays).toBeGreaterThanOrEqual(27);
    expect(diffDays).toBeLessThanOrEqual(32);
  });

  it('handles scope of 0 for days (start equals end)', () => {
    const result = calculateDateRange(0, 'days');
    const diffMs = Math.abs(result.end.getTime() - result.start.getTime());
    // Should be approximately the same time (within a few ms of execution)
    expect(diffMs).toBeLessThan(100);
  });

  it('throws for unknown unit', () => {
    expect(() => calculateDateRange(1, 'centuries')).toThrow('Unknown date unit: centuries');
  });

  it('end is approximately now', () => {
    const before = Date.now();
    const result = calculateDateRange(1, 'days');
    const after = Date.now();
    expect(result.end.getTime()).toBeGreaterThanOrEqual(before);
    expect(result.end.getTime()).toBeLessThanOrEqual(after);
  });
});
