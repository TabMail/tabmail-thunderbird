/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// eventLinkAllDayTooltip.test.js — the tooltip of an all-day event link in the
// chat names the event's own day in every zone. An all-day value is a DATE: a
// calendar day with no zone and no instant. The bridge reports its `start` as
// UTC midnight of that day (ical.js converts no DATE), so reading that instant
// with local getters names the previous day anywhere west of UTC. The event
// comes from the REAL bridge (tmCalendar.sys.mjs in node:vm, through
// calendarBridgeHarness.js) and the REAL entityResolver and markdown modules,
// so the test covers what the bridge returns, not a hand-written copy of it.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: (s) => s,
  resolveUniqueMessageKey: vi.fn(async () => null),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

globalThis.browser = { tmCalendar: { getCalendarEventDetails: vi.fn(async () => ({ ok: false })) } };

const { loadCalendarBridge, fakeDate, fakeDateTime, fakeEvent } = await import('./helpers/calendarBridgeHarness.js');
const { renderMarkdown, attachSpecialLinkListeners } = await import('../chat/modules/markdown.js');
const { getGenericTimezoneAbbr } = await import('../chat/modules/helpers.js');

// 2099-11-12 is a Thursday.
const DAY = '2099-11-12';
const NEXT_DAY = '2099-11-13';
const THREE_DAYS_ON = '2099-11-15';

// Three zones west of UTC (UTC-5, UTC-8, UTC-10 in November) where UTC
// midnight is still the day before, and one east of UTC as a control.
const ZONES = ['America/New_York', 'America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Auckland'];

let dom;

/** Loads `item` into the bridge, renders a link to it, clicks it, and returns the link and the tooltip's date/time line. */
async function tooltipFor(item) {
  const { api } = loadCalendarBridge(bridgeUrl, { items: [item] });
  browser.tmCalendar.getCalendarEventDetails.mockImplementation((id) => api.getCalendarEventDetails(id, 'cal1'));
  const container = document.getElementById('chat');
  container.innerHTML = await renderMarkdown(`See [Event](cal1:${item.id}) soon.`);
  attachSpecialLinkListeners(container);
  const link = container.querySelector('.tm-event-link');
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  const tooltip = document.querySelector('.tm-tooltip');
  return { link, when: tooltip.querySelectorAll('.tm-tooltip-field')[0].textContent };
}

// One document for the file: the click handler arms a global click listener on
// a timer that can fire after a test ends, so the document stays defined.
beforeAll(() => {
  dom = new JSDOM('<body><div id="chat"></div></body>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
});

beforeEach(() => {
  document.body.innerHTML = '<div id="chat"></div>';
});

describe.each(ZONES)('with the process zone %s', (zone) => {
  const originalTz = process.env.TZ;
  beforeAll(() => { process.env.TZ = zone; });
  afterAll(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('precondition: the bridge gives the all-day event as UTC midnight of its day, flagged all-day with its day digits', async () => {
    const { api } = loadCalendarBridge(bridgeUrl, { items: [fakeEvent({ id: 'ad', title: 'Holiday', startDate: fakeDate(DAY), endDate: fakeDate(NEXT_DAY) })] });
    const details = await api.getCalendarEventDetails('ad', 'cal1');
    expect(details).toMatchObject({ ok: true, isAllDay: true, startDay: DAY, endDay: NEXT_DAY, start: Date.UTC(2099, 10, 12), end: Date.UTC(2099, 10, 13) });
  });

  it('the tooltip of a one-day all-day event names that day', async () => {
    const { when } = await tooltipFor(fakeEvent({ id: 'ad', title: 'Holiday', startDate: fakeDate(DAY), endDate: fakeDate(NEXT_DAY) }));
    expect(when.split('\n')[0]).toMatch(/^Thursday, Nov 12\b/);
    expect(when).not.toContain('Nov 11');
  });

  it('the tooltip of a one-day all-day event reads "Thursday, Nov 12" then "All day"', async () => {
    const { link, when } = await tooltipFor(fakeEvent({ id: 'ad', title: 'Holiday', startDate: fakeDate(DAY), endDate: fakeDate(NEXT_DAY) }));
    expect(when).toBe('Thursday, Nov 12\nAll day');
    // The link carries the date-only days, not an instant to be read in a zone.
    const data = JSON.parse(link.getAttribute('data-tm-tooltip'));
    expect(data).toMatchObject({ allDay: true, startDay: DAY, endDay: NEXT_DAY });
  });

  it('the tooltip of a three-day all-day event names its first and last day (the end is exclusive)', async () => {
    const { when } = await tooltipFor(fakeEvent({ id: 'md', title: 'Retreat', startDate: fakeDate(DAY), endDate: fakeDate(THREE_DAYS_ON) }));
    expect(when).toBe('Thursday, Nov 12 -- Saturday, Nov 14\nAll day');
  });

  it('a timed event keeps its local day and times (unchanged)', async () => {
    const { when } = await tooltipFor(fakeEvent({ id: 't', title: 'Sync', startDate: fakeDateTime(DAY, 10), endDate: fakeDateTime(DAY, 11) }));
    const tz = getGenericTimezoneAbbr(new Date(2099, 10, 12, 10));
    expect(when).toBe(`Thursday, Nov 12${tz ? `, ${tz}` : ''}\n10:00 AM -- 11:00 AM`);
  });
});
