/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// A calendar attachment's notes (DESCRIPTION, or the HTML X-ALT-DESC) become
// plain text for the event's brief. They are read in a document of their own:
// reading them never reaches the page that reads the mail, and their text
// stays as the notes show it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JSDOM } from 'jsdom';

vi.mock('../agent/modules/utils.js', () => ({ log: vi.fn() }));
vi.mock('../chat/modules/helpers.js', () => ({
  formatTimestampForAgent: d => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
  toIsoNoMs: d => d.toISOString().replace(/\.\d{3}Z$/, 'Z'),
}));

const { parseIcsToEvents, ICS_PARSER_SETTINGS } = await import('../chat/modules/icsParser.js');

let dom;
let pageReached = [];

// The page stays installed, and every reach into it (its window or its
// document) is recorded. Code can hand the notes to the page only through
// these, since a document of its own has no window: parsing markup into the
// page, copying, adopting or moving nodes into it all read one of them.
beforeEach(() => {
  dom = new JSDOM('<body></body>');
  const page = { window: dom.window, document: dom.window.document };
  for (const name of Object.keys(page)) {
    Object.defineProperty(globalThis, name, { configurable: true, get() { pageReached.push(name); return page[name]; } });
  }
  globalThis.DOMParser = dom.window.DOMParser;
});

afterEach(() => {
  dom.window.close();
  delete globalThis.window;
  delete globalThis.document;
  delete globalThis.DOMParser;
});

// What running `read` reaches of the page, beside its result.
function reachOf(read) {
  pageReached = [];
  const result = read();
  const reached = pageReached;
  pageReached = [];
  return [result, reached];
}

const stamp = days => new Date(Date.now() + days * 86400000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

function eventOf(lines) {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Test//EN', 'BEGIN:VEVENT',
    'UID:notes@example.com', `DTSTART:${stamp(7)}`, `DTEND:${stamp(7.05)}`, 'SUMMARY:Plan',
    ...lines, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const [events, reached] = reachOf(() => parseIcsToEvents(ics));
  expect(reached).toEqual([]);
  expect(events).toHaveLength(1);
  return events[0];
}

const notesOf = lines => eventOf(lines).notes_brief;
const truncated = ev => ev.parse_warnings.filter(w => w.includes('truncated'));

const NOTES = [
  ['plain text', 'Agenda for the review, bring the deck', 'Agenda for the review, bring the deck'],
  ['bold and a line break', 'Bring <b>the deck</b><br>and notes', 'Bring the deckand notes'],
  ['an anchor', 'Join at <a href="https://example.com/room">the room</a> now', 'Join at the room now'],
  ['an image', 'Floor plan <img src="https://example.com/plan.png"> attached', 'Floor plan attached'],
  ['character references', 'Q&amp;A &lt;room 4&gt; &quot;quiet&quot;', 'Q&A <room 4> "quiet"'],
  ['a styled span', '<span style="color: red" data-x="1">Moved</span> to Friday', 'Moved to Friday'],
  ['a title before the notes', '<title>Bring the deck</title><p>Room 4</p>', 'Bring the deckRoom 4'],
  ['a whole document with a head', '<html><head><title>Agenda</title></head><body><p>Room 4</p></body></html>', 'AgendaRoom 4'],
  ['a style part in a head', '<html><head><style>.agenda{color:blue}</style></head><body>Ready</body></html>', '.agenda{color:blue}Ready'],
  ['white space at both edges', ' \t Ready \t ', 'Ready'],
  ['an element of a name no standard knows', '<notes-probe>Ready</notes-probe>', 'Ready'],
];

describe('the page record sees a reach into the page', () => {
  it.each([
    ['its document', () => document.createElement('div'), ['document']],
    ['its window', () => window.document, ['window']],
    ['a document of its own made from the page', () => document.implementation.createHTMLDocument(''), ['document']],
  ])('a reach through %s is seen', (_label, read, reached) => {
    expect(reachOf(read)[1]).toEqual(reached);
  });

  it('a document of its own made by DOMParser is not', () => {
    const [, reached] = reachOf(() => {
      const own = new DOMParser().parseFromString('', 'text/html');
      own.createElement('div').innerHTML = '<b>x</b>';
    });
    expect(reached).toEqual([]);
  });
});

describe('calendar notes read as text in their own document', () => {
  it.each(NOTES)('a DESCRIPTION holding %s gives its text', (_label, notes, text) => {
    expect(notesOf([`DESCRIPTION:${notes}`])).toBe(text);
  });

  it.each(NOTES)('an HTML X-ALT-DESC holding %s gives its text, over the DESCRIPTION', (_label, notes, text) => {
    expect(notesOf(['DESCRIPTION:Plain notes', `X-ALT-DESC;FMTTYPE=text/html:${notes}`])).toBe(text);
  });

  it('no note ever reaches the page', () => {
    for (const [, notes] of NOTES) {
      notesOf([`DESCRIPTION:${notes}`]);
      notesOf([`X-ALT-DESC;FMTTYPE=text/html:${notes}`]);
    }
    expect(reachOf(() => document.body.innerHTML)[0]).toBe('');
  });

  it('runs of white space in the notes become one space', () => {
    expect(notesOf(['X-ALT-DESC;FMTTYPE=text/html:<p>First</p>  \t <p>  second  line</p>'])).toBe('First second line');
  });

  it('no notes, empty notes and notes of white space or empty markup give an empty brief', () => {
    for (const lines of [[], ['DESCRIPTION:'], ['DESCRIPTION:   \t '], ['X-ALT-DESC;FMTTYPE=text/html:<p> </p><img src="https://example.com/a.png">']]) {
      const ev = eventOf(lines);
      expect(ev.notes_brief).toBe('');
      expect(truncated(ev)).toEqual([]);
    }
  });

  it('an empty X-ALT-DESC leaves the DESCRIPTION as the notes', () => {
    expect(notesOf(['DESCRIPTION:Plain notes', 'X-ALT-DESC;FMTTYPE=text/html:'])).toBe('Plain notes');
  });

  it('notes up to the brief limit stay whole; longer ones are cut to it with a warning', () => {
    const limit = ICS_PARSER_SETTINGS.notesBriefMaxChars;
    for (const [length, kept, warned] of [[limit - 1, limit - 1, false], [limit, limit, false], [limit + 1, limit, true]]) {
      const text = 'x'.repeat(length);
      for (const lines of [[`DESCRIPTION:${text}`], [`X-ALT-DESC;FMTTYPE=text/html:<p><b>${text}</b></p>`]]) {
        const ev = eventOf(lines);
        expect(ev.notes_brief).toBe('x'.repeat(kept));
        expect(truncated(ev)).toEqual(warned ? ['HTML body truncated'] : []);
      }
    }
  });
});
