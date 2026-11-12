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
// The chat's @-mention list shows the same event's date (entityResolver's
// `startDate`, in the user's locale) and has the same cause, so it is pinned
// here too, through the real mentionAutocomplete dropdown.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  normalizeUnicode: (s) => s,
  resolveUniqueMessageKey: vi.fn(async () => null),
}));

// The @-mention list also offers templates; none are needed here.
vi.mock('../agent/modules/templateManager.js', () => ({
  getVisibleTemplates: vi.fn(async () => []),
  getTemplate: vi.fn(async () => null),
}));

const __dirname = dirname(fileURLToPath(import.meta.url));
const bridgeUrl = resolve(__dirname, '../chat/experiments/tmCalendar/tmCalendar.sys.mjs');

globalThis.browser = {
  tmCalendar: { getCalendarEventDetails: vi.fn(async () => ({ ok: false })) },
  // mentionAutocomplete imports config.js, which listens for storage changes.
  storage: { onChanged: { addListener: vi.fn() } },
};

const { loadCalendarBridge, fakeDate, fakeDateTime, fakeEvent, fixedZone } = await import('./helpers/calendarBridgeHarness.js');
const { renderMarkdown, attachSpecialLinkListeners } = await import('../chat/modules/markdown.js');
const { getGenericTimezoneAbbr } = await import('../chat/modules/helpers.js');
const { initMentionAutocomplete, cleanupMentionAutocomplete } = await import('../chat/modules/mentionAutocomplete.js');
const { ctx } = await import('../chat/modules/context.js');
const { stubDefaultLocale } = await import('./helpers/defaultLocale.js');

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

/**
 * Loads `item` into the bridge as an event the assistant linked earlier in the
 * chat (an `entityMap` entry, as idTranslator stores one), types `typed` into
 * the message box, and returns the @-mention dropdown's items as
 * `{ label, description }`.
 */
async function mentionItemsFor(item, typed) {
  const { api } = loadCalendarBridge(bridgeUrl, { items: [item] });
  browser.tmCalendar.getCalendarEventDetails.mockImplementation((id) => api.getCalendarEventDetails(id, 'cal1'));
  ctx.entityMap.clear();
  ctx.entityMap.set('1:1', { type: 'event', compoundNumericId: '1:1', realEventId: item.id, realCalendarId: 'cal1' });
  const input = document.createElement('div');
  input.setAttribute('contenteditable', 'true');
  document.body.appendChild(input);
  initMentionAutocomplete(input);
  try {
    input.textContent = typed;
    const range = document.createRange();
    range.setStart(input.firstChild, typed.length);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    const dropdown = document.getElementById('mention-autocomplete-dropdown');
    await vi.waitFor(() => {
      if (dropdown.style.display === 'none' || !dropdown.querySelector('.mention-autocomplete-item')) throw new Error('no dropdown yet');
    });
    return [...dropdown.querySelectorAll('.mention-autocomplete-item')].map((el) => ({
      label: el.querySelector('.mention-item-label').textContent,
      description: el.querySelector('.mention-item-description').textContent,
    }));
  } finally {
    // Leave @ mode so the next call refreshes the list, then remove the dropdown.
    input.textContent = '';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    cleanupMentionAutocomplete();
  }
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

  it('an all-day event with no end (a DATE start without DTEND) is that one day', async () => {
    const { link, when } = await tooltipFor(fakeEvent({ id: 'ne', title: 'Holiday', startDate: fakeDate(DAY), endDate: null }));
    expect(JSON.parse(link.getAttribute('data-tm-tooltip'))).toMatchObject({ allDay: true, startDay: DAY, endDay: '' });
    expect(when).toBe('Thursday, Nov 12\nAll day');
  });

  it('a timed event keeps its local day and times (unchanged)', async () => {
    const { when } = await tooltipFor(fakeEvent({ id: 't', title: 'Sync', startDate: fakeDateTime(DAY, 10), endDate: fakeDateTime(DAY, 11) }));
    const tz = getGenericTimezoneAbbr(new Date(2099, 10, 12, 10));
    expect(when).toBe(`Thursday, Nov 12${tz ? `, ${tz}` : ''}\n10:00 AM -- 11:00 AM`);
  });

  describe('the @-mention list', () => {
    let restoreLocale;
    afterAll(() => restoreLocale?.());

    it('an all-day event is listed under its own day (en-US)', async () => {
      restoreLocale?.();
      restoreLocale = stubDefaultLocale('en-US');
      const items = await mentionItemsFor(fakeEvent({ id: 'ad', title: 'Holiday', startDate: fakeDate(DAY), endDate: fakeDate(NEXT_DAY) }), '@Holi');
      expect(items).toEqual([{ label: 'Holiday', description: 'Event • 11/12/2099' }]);
    });

    it('typing an all-day event\'s own date finds it', async () => {
      restoreLocale?.();
      restoreLocale = stubDefaultLocale('en-US');
      const items = await mentionItemsFor(fakeEvent({ id: 'ad', title: 'Holiday', startDate: fakeDate(DAY), endDate: fakeDate(NEXT_DAY) }), '@11/12/2099');
      expect(items).toEqual([{ label: 'Holiday', description: 'Event • 11/12/2099' }]);
    });

    it('an all-day event\'s day stays in the user\'s locale (en-GB)', async () => {
      restoreLocale?.();
      restoreLocale = stubDefaultLocale('en-GB');
      const items = await mentionItemsFor(fakeEvent({ id: 'ad', title: 'Holiday', startDate: fakeDate(DAY), endDate: fakeDate(NEXT_DAY) }), '@Holi');
      expect(items).toEqual([{ label: 'Holiday', description: 'Event • 12/11/2099' }]);
    });

    // An all-day DATE stored with a zone (another app's, or one TabMail wrote
    // before all-day values were written floating) has its `start` at midnight in
    // that zone: for Europe/Berlin 2099-11-12 that is 23:00 UTC on Nov 11. Its day
    // is still its own date digits, so reading that instant in UTC (or in the
    // user's zone) would name the wrong day.
    it('an all-day event stored with a zone east of UTC is listed under its own day', async () => {
      restoreLocale?.();
      restoreLocale = stubDefaultLocale('en-US');
      const berlin = fixedZone('Europe/Berlin', 60);
      const items = await mentionItemsFor(fakeEvent({ id: 'zd', title: 'Holiday', startDate: fakeDate(DAY, berlin), endDate: fakeDate(NEXT_DAY, berlin) }), '@Holi');
      expect(items).toEqual([{ label: 'Holiday', description: 'Event • 11/12/2099' }]);
    });

    it('a timed event keeps its local day (unchanged)', async () => {
      restoreLocale?.();
      restoreLocale = stubDefaultLocale('en-US');
      const items = await mentionItemsFor(fakeEvent({ id: 't', title: 'Sync', startDate: fakeDateTime(DAY, 10), endDate: fakeDateTime(DAY, 11) }), '@Sync');
      expect(items).toEqual([{ label: 'Sync', description: 'Event • 11/12/2099' }]);
    });
  });
});
