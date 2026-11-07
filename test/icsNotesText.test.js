/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A calendar attachment's notes (DESCRIPTION, or the HTML X-ALT-DESC) become
// plain text for the event's brief. They are read in a document of their own,
// never as markup in the page that reads the mail, and their text stays as
// the notes show it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/helpers.js', () => ({
  formatTimestampForAgent: d => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  toIsoNoMs: d => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
}));

const { parseIcsToEvents } = await import('../chat/modules/icsParser.js');

let dom;
let markupSet;

beforeEach(() => {
  dom = new JSDOM('<body></body>');
  markupSet = [];
  // Every way the page's own elements take markup records what it was given.
  const proto = dom.window.Element.prototype;
  for (const name of ['innerHTML', 'outerHTML']) {
    const original = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, {
      configurable: true,
      get: original.get,
      set(value) { markupSet.push(String(value)); original.set.call(this, value); },
    });
  }
  const insert = proto.insertAdjacentHTML;
  proto.insertAdjacentHTML = function (where, value) { markupSet.push(String(value)); return insert.call(this, where, value); };
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  globalThis.DOMParser = dom.window.DOMParser;
});

afterEach(() => {
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.DOMParser;
});

const stamp = days => new Date(Date.now() + days * 86400000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function notesOf(lines) {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Test//EN', 'BEGIN:VEVENT',
    'UID:notes@example.com', `DTSTART:${stamp(7)}`, `DTEND:${stamp(7.05)}`, 'SUMMARY:Plan',
    ...lines, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const events = parseIcsToEvents(ics);
  expect(events).toHaveLength(1);
  return events[0].notes_brief;
}

const NOTES = [
  ['plain text', 'Agenda for the review, bring the deck', 'Agenda for the review, bring the deck'],
  ['bold and a line break', 'Bring <b>the deck</b><br>and notes', 'Bring the deckand notes'],
  ['an anchor', 'Join at <a href="https://example.com/room">the room</a> now', 'Join at the room now'],
  ['an image', 'Floor plan <img src="https://example.com/plan.png"> attached', 'Floor plan attached'],
  ['character references', 'Q&amp;A &lt;room 4&gt; &quot;quiet&quot;', 'Q&A <room 4> "quiet"'],
  ['a styled span', '<span style="color: red" data-x="1">Moved</span> to Friday', 'Moved to Friday'],
];

describe('calendar notes read as text in their own document', () => {
  it.each(NOTES)('a DESCRIPTION holding %s gives its text', (_label, notes, text) => {
    expect(notesOf([`DESCRIPTION:${notes}`])).toBe(text);
    expect(markupSet.filter(value => value.includes(notes))).toEqual([]);
  });

  it.each(NOTES)('an HTML X-ALT-DESC holding %s gives its text, over the DESCRIPTION', (_label, notes, text) => {
    expect(notesOf(['DESCRIPTION:Plain notes', `X-ALT-DESC;FMTTYPE=text/html:<html><body>${notes}</body></html>`])).toBe(text);
    expect(markupSet).toEqual([]);
  });

  it('no note is ever given to the page as markup', () => {
    for (const [, notes] of NOTES) {
      notesOf([`DESCRIPTION:${notes}`]);
      notesOf([`X-ALT-DESC;FMTTYPE=text/html:${notes}`]);
    }
    expect(markupSet).toEqual([]);
    expect(document.body.innerHTML).toBe('');
  });

  it('runs of white space in the notes become one space', () => {
    expect(notesOf(['X-ALT-DESC;FMTTYPE=text/html:<p>First</p>  \t <p>  second  line</p>'])).toBe('First second line');
  });
});
