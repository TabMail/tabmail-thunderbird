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

const { parseIcsToEvents, ICS_PARSER_SETTINGS } = await import('../chat/modules/icsParser.js');

let dom;
let pageParsed;
let pageActivated;

// Records every way markup can be parsed into the page's own document: an
// element's markup setters, a range's fragment and the document's write.
function watchPageParsing(win) {
  const page = win.document;
  const record = (how, value) => pageParsed.push([how, String(value)]);
  const proto = win.Element.prototype;
  for (const name of ['innerHTML', 'outerHTML']) {
    const original = Object.getOwnPropertyDescriptor(proto, name);
    Object.defineProperty(proto, name, {
      configurable: true,
      get: original.get,
      set(value) { if (this.ownerDocument === page) record(name, value); original.set.call(this, value); },
    });
  }
  const insert = proto.insertAdjacentHTML;
  proto.insertAdjacentHTML = function (where, value) { if (this.ownerDocument === page) record('insertAdjacentHTML', value); return insert.call(this, where, value); };
  const fragment = win.Range.prototype.createContextualFragment;
  win.Range.prototype.createContextualFragment = function (value) {
    const owner = this.startContainer.ownerDocument || this.startContainer;
    if (owner === page) record('createContextualFragment', value);
    return fragment.call(this, value);
  };
  for (const name of ['write', 'writeln']) {
    const original = win.Document.prototype[name];
    win.Document.prototype[name] = function (...values) { if (this === page) record(name, values.join('')); return original.apply(this, values); };
  }
}

beforeEach(() => {
  dom = new JSDOM('<body></body>');
  pageParsed = [];
  pageActivated = [];
  watchPageParsing(dom.window);
  // An element the page knows comes alive only once it belongs to the page's
  // document: it records that, as anything active in the page could act.
  dom.window.customElements.define('notes-probe', class extends dom.window.HTMLElement {
    constructor() { super(); pageActivated.push(this.textContent); }
  });
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

function eventOf(lines) {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Test//Test//EN', 'BEGIN:VEVENT',
    'UID:notes@example.com', `DTSTART:${stamp(7)}`, `DTEND:${stamp(7.05)}`, 'SUMMARY:Plan',
    ...lines, 'END:VEVENT', 'END:VCALENDAR',
  ].join('\r\n');
  const events = parseIcsToEvents(ics);
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
  ['a noscript part', '<noscript>Bring <b>the deck</b></noscript><p>Room 4</p>', 'Bring the deckRoom 4'],
  ['a style part in a head', '<html><head><style>.agenda{color:blue}</style></head><body>Ready</body></html>', '.agenda{color:blue}Ready'],
  ['white space at both edges', ' \t Ready \t ', 'Ready'],
  ['an element the page knows', '<notes-probe>Ready</notes-probe>', 'Ready'],
];

describe('the page watch sees markup parsed into the page', () => {
  it.each([
    ['innerHTML', () => document.createElement('div').innerHTML = '<b>x</b>'],
    ['outerHTML', () => { const p = document.createElement('p'); document.body.append(p); p.outerHTML = '<b>x</b>'; }],
    ['insertAdjacentHTML', () => document.createElement('div').insertAdjacentHTML('beforeend', '<b>x</b>')],
    ['createContextualFragment', () => document.createRange().createContextualFragment('<b>x</b>')],
    ['write', () => document.write('<b>x</b>')],
    ['writeln', () => document.writeln('<b>x</b>')],
  ])('%s into the page is seen', (how, parse) => {
    parse();
    expect(pageParsed).toEqual([[how, '<b>x</b>']]);
  });

  it('markup parsed into a document of its own is not', () => {
    const own = new DOMParser().parseFromString('', 'text/html');
    own.createElement('div').innerHTML = '<b>x</b>';
    own.createRange().createContextualFragment('<b>x</b>');
    expect(pageParsed).toEqual([]);
  });

  it('an element the page knows comes alive once copied into the page, not before', () => {
    const own = new DOMParser().parseFromString('', 'text/html');
    const holder = own.createElement('div');
    holder.innerHTML = '<notes-probe>Ready</notes-probe>';
    expect(pageActivated).toEqual([]);
    document.importNode(holder, true);
    expect(pageActivated).toEqual(['Ready']);
  });
});

describe('calendar notes read as text in their own document', () => {
  it.each(NOTES)('a DESCRIPTION holding %s gives its text', (_label, notes, text) => {
    expect(notesOf([`DESCRIPTION:${notes}`])).toBe(text);
    expect(pageParsed).toEqual([]);
    expect(pageActivated).toEqual([]);
  });

  it.each(NOTES)('an HTML X-ALT-DESC holding %s gives its text, over the DESCRIPTION', (_label, notes, text) => {
    expect(notesOf(['DESCRIPTION:Plain notes', `X-ALT-DESC;FMTTYPE=text/html:${notes}`])).toBe(text);
    expect(pageParsed).toEqual([]);
    expect(pageActivated).toEqual([]);
  });

  it('no note is ever parsed into the page', () => {
    for (const [, notes] of NOTES) {
      notesOf([`DESCRIPTION:${notes}`]);
      notesOf([`X-ALT-DESC;FMTTYPE=text/html:${notes}`]);
    }
    expect(pageParsed).toEqual([]);
    expect(pageActivated).toEqual([]);
    expect(document.body.innerHTML).toBe('');
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
    expect(pageParsed).toEqual([]);
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
    expect(pageParsed).toEqual([]);
  });
});
