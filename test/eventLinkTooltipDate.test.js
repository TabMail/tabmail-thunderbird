/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// An event link in the chat shows the event's day and times in its tooltip,
// in any UI language. The link keeps the event's start and end as Thunderbird
// returns them and formats them only when the tooltip is drawn. A date written
// in the user's locale and parsed back names the wrong day: in en-GB,
// 12 November reads back as 11 December; a Thai date carries the Buddhist year.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';
import { stubDefaultLocale } from './helpers/defaultLocale.js';

const h = vi.hoisted(() => ({ event: null }));

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn(), normalizeUnicode: (s) => s }));
vi.mock('../chat/modules/entityResolver.js', () => ({
  resolveContactDetails: vi.fn(async () => null),
  resolveEventDetails: vi.fn(async () => h.event),
}));
vi.mock('../chat/modules/helpers.js', () => ({ getGenericTimezoneAbbr: () => '' }));

const { renderMarkdown, attachSpecialLinkListeners } = await import('../chat/modules/markdown.js');

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Next year's 12 November, 10:00 to 11:00 local: day and month both read as a
// month, so a day/month swap still parses, to the wrong day.
const year = new Date().getFullYear() + 1;
const start = new Date(year, 10, 12, 10, 0, 0);
const end = new Date(year, 10, 12, 11, 0, 0);

let dom;
let restoreLocale;

/** Renders an event link, clicks it, and returns the link and the tooltip drawn. */
async function clickEventLink() {
  const container = document.getElementById('chat');
  container.innerHTML = await renderMarkdown('See [Event](cal-1:evt-1) today.');
  attachSpecialLinkListeners(container);
  const link = container.querySelector('.tm-event-link');
  link.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  return { link, tooltip: document.querySelector('.tm-tooltip') };
}

beforeEach(() => {
  dom = new JSDOM('<body><div id="chat"></div></body>', { pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // tmCalendar.getCalendarEventDetails returns start and end in epoch ms.
  h.event = { ok: true, title: 'Planning review', start: start.getTime(), end: end.getTime(), attendees: 0, attendeeList: [] };
});

afterEach(() => {
  restoreLocale();
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
});

describe.each(['en-GB', 'th'])('with the default locale %s', (locale) => {
  beforeEach(() => { restoreLocale = stubDefaultLocale(locale); });

  it('the event link keeps the event times as returned and its tooltip names the event day', async () => {
    const { link, tooltip } = await clickEventLink();
    const data = JSON.parse(link.getAttribute('data-tm-tooltip'));
    expect(data.startTime).toBe(start.getTime());
    expect(data.endTime).toBe(end.getTime());
    expect(tooltip).not.toBeNull();
    const when = tooltip.querySelectorAll('.tm-tooltip-field')[0].textContent;
    expect(when).toBe(`${WEEKDAYS[start.getDay()]}, Nov 12\n10:00 AM -- 11:00 AM`);
  });

  it('an event without a start or end shows that its time is unknown', async () => {
    h.event = { ...h.event, start: '', end: '' };
    const { link, tooltip } = await clickEventLink();
    const data = JSON.parse(link.getAttribute('data-tm-tooltip'));
    expect(data.startTime).toBe('Unknown start time');
    expect(data.endTime).toBe('Unknown end time');
    expect(tooltip.querySelectorAll('.tm-tooltip-field')[0].textContent).toBe('Unknown date/time');
  });
});
