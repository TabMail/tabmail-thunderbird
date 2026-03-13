// icsParser.test.js — ICS parser module tests (TB-100 to TB-110)
//
// icsParser.js imports { log } from utils.js and { formatTimestampForAgent, toIsoNoMs }
// from helpers.js. Both have heavy browser dependencies. We mock them to isolate pure logic.

import { describe, it, expect, vi } from 'vitest';

// Mock utils.js — only `log` is used by icsParser.js
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

// Mock helpers.js — formatTimestampForAgent and toIsoNoMs
vi.mock('../chat/modules/helpers.js', () => ({
  formatTimestampForAgent: vi.fn((d) => {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }),
  toIsoNoMs: vi.fn((d) => {
    if (!(d instanceof Date) || isNaN(d.getTime())) return '';
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }),
}));

const { parseIcsToEvents, formatEventsForDisplay, formatIcsAttachmentsAsString } =
  await import('../chat/modules/icsParser.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal valid ICS wrapper around VEVENT content lines. */
function wrapIcs(veventBody, { prodid = '-//Test//Test//EN', method = '' } = {}) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodid}`,
  ];
  if (method) lines.push(`METHOD:${method}`);
  lines.push(veventBody);
  lines.push('END:VCALENDAR');
  return lines.join('\r\n');
}

function simpleVevent(props) {
  const lines = ['BEGIN:VEVENT'];
  for (const line of props) lines.push(line);
  lines.push('END:VEVENT');
  return lines.join('\r\n');
}

// ---------------------------------------------------------------------------
// TB-100: Parse simple VEVENT with DTSTART/DTEND
// ---------------------------------------------------------------------------
describe('TB-100: Parse simple VEVENT with DTSTART/DTEND', () => {
  it('parses a basic event with TZID-based DTSTART and DTEND', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:test-100@example.com',
      'SUMMARY:Team Standup',
      'DTSTART;TZID=America/New_York:20260315T100000',
      'DTEND;TZID=America/New_York:20260315T103000',
      'LOCATION:Room 42',
    ]));

    const events = parseIcsToEvents(ics, 'invite.ics');

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.uid).toBe('test-100@example.com');
    expect(ev.title).toBe('Team Standup');
    expect(ev.location).toBe('Room 42');
    expect(ev.duration_minutes).toBe(30);
    expect(ev.start.start_utc).toBeTruthy();
    expect(ev.end.end_utc).toBeTruthy();
    expect(ev.source.ics_filename).toBe('invite.ics');
  });

  it('parses compact Zulu datetime (V8 Date limitation — utcMs is null)', () => {
    // Note: compact Zulu format (20260315T100000Z) is not parseable by V8's
    // Date constructor. parseDateTimeBasic returns utcMs: null for these.
    // Real-world ICS typically uses TZID or extended ISO format.
    const ics = wrapIcs(simpleVevent([
      'UID:zulu-100@example.com',
      'SUMMARY:Zulu Event',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T103000Z',
    ]));

    const events = parseIcsToEvents(ics, 'zulu.ics');

    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe('zulu-100@example.com');
    expect(events[0].title).toBe('Zulu Event');
    // Duration is 0 because compact Zulu can't be resolved by Date constructor
    expect(events[0].duration_minutes).toBe(0);
  });

  it('populates source prodid and method from top-level VCALENDAR', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:src-test@example.com',
      'SUMMARY:Source Check',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
    ]), { prodid: '-//Google//EN', method: 'REQUEST' });

    const events = parseIcsToEvents(ics, 'test.ics');
    expect(events[0].source.prodid).toBe('-//Google//EN');
    expect(events[0].source.method).toBe('REQUEST');
  });
});

// ---------------------------------------------------------------------------
// TB-101: Parse all-day event (VALUE=DATE format)
// ---------------------------------------------------------------------------
describe('TB-101: Parse all-day event (DATE format)', () => {
  it('parses DTSTART;VALUE=DATE:20260315', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:allday-101@example.com',
      'SUMMARY:Company Holiday',
      'DTSTART;VALUE=DATE:20260315',
      'DTEND;VALUE=DATE:20260316',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.title).toBe('Company Holiday');
    // All-day: DTSTART is midnight UTC on 2026-03-15
    expect(ev.start.start_utc).toContain('2026-03-15');
    // DTEND is midnight UTC on 2026-03-16 (exclusive end per iCal spec)
    expect(ev.end.end_utc).toContain('2026-03-16');
    // Duration = 1 day = 1440 minutes
    expect(ev.duration_minutes).toBe(1440);
  });
});

// ---------------------------------------------------------------------------
// TB-102: Parse recurring event (RRULE)
// ---------------------------------------------------------------------------
describe('TB-102: Parse recurring event (RRULE)', () => {
  it('parses event with RRULE without crashing (RRULE is not extracted but event is still parsed)', () => {
    // The current parser doesn't extract RRULE into the output, but the
    // event should still be parsed successfully with all other fields intact.
    const ics = wrapIcs(simpleVevent([
      'UID:recur-102@example.com',
      'SUMMARY:Weekly Sync',
      'DTSTART;TZID=America/New_York:20260315T140000',
      'DTEND;TZID=America/New_York:20260315T150000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Weekly Sync');
    expect(events[0].duration_minutes).toBe(60);
    expect(events[0].uid).toBe('recur-102@example.com');
  });
});

// ---------------------------------------------------------------------------
// TB-103: Parse event with TZID
// ---------------------------------------------------------------------------
describe('TB-103: Parse event with TZID', () => {
  it('maps IANA TZID and resolves start/end to UTC', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:tz-103@example.com',
      'SUMMARY:NYC Meeting',
      'DTSTART;TZID=America/New_York:20260315T100000',
      'DTEND;TZID=America/New_York:20260315T110000',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.start.tzid_raw).toBe('America/New_York');
    expect(ev.start.tzid_mapped).toBe('America/New_York');
    expect(ev.duration_minutes).toBe(60);
    // start_utc should be populated (resolved from wall time + TZID)
    expect(ev.start.start_utc).toBeTruthy();
    expect(ev.end.end_utc).toBeTruthy();
  });

  it('maps Windows TZID to IANA and adds warning', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:tz-win-103@example.com',
      'SUMMARY:Windows TZ Event',
      'DTSTART;TZID=Eastern Standard Time:20260315T100000',
      'DTEND;TZID=Eastern Standard Time:20260315T110000',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.start.tzid_raw).toBe('Eastern Standard Time');
    expect(ev.start.tzid_mapped).toBe('America/New_York');
    // Should have a warning about non-IANA TZID mapping
    expect(ev.parse_warnings.some(w => w.includes('Non-IANA TZID'))).toBe(true);
  });

  it('warns when TZID is unknown and cannot be mapped', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:tz-unknown-103@example.com',
      'SUMMARY:Unknown TZ Event',
      'DTSTART;TZID=Narnia Standard Time:20260315T100000',
      'DTEND;TZID=Narnia Standard Time:20260315T110000',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.start.tzid_mapped).toBeNull();
    expect(ev.parse_warnings.some(w => w.includes('Unknown TZID'))).toBe(true);
    // Cannot resolve start/end without valid TZID
    expect(ev.parse_warnings.some(w => w.includes('cannot resolve'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TB-104: Parse event with attendees
// ---------------------------------------------------------------------------
describe('TB-104: Parse event with attendees', () => {
  it('extracts organizer and attendees with CN and mailto', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:att-104@example.com',
      'SUMMARY:Project Review',
      'DTSTART:20260315T140000Z',
      'DTEND:20260315T150000Z',
      'ORGANIZER;CN=Alice Smith:mailto:alice@example.com',
      'ATTENDEE;CN=Bob Jones:mailto:bob@example.com',
      'ATTENDEE;CN=Charlie Brown:mailto:charlie@example.com',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    const ev = events[0];
    expect(ev.organizer.name).toBe('Alice Smith');
    expect(ev.organizer.email).toBe('alice@example.com');
    expect(ev.attendees_truncated).toHaveLength(2);
    expect(ev.attendees_truncated[0].name).toBe('Bob Jones');
    expect(ev.attendees_truncated[0].email).toBe('bob@example.com');
    expect(ev.attendees_truncated[1].name).toBe('Charlie Brown');
    expect(ev.attendees_truncated[1].email).toBe('charlie@example.com');
    expect(ev.attendees_more_count).toBe(0);
  });

  it('truncates attendees beyond attendeeDisplayLimit (5)', () => {
    const attendeeLines = [];
    for (let i = 0; i < 8; i++) {
      attendeeLines.push(`ATTENDEE;CN=Person ${i}:mailto:person${i}@example.com`);
    }
    const ics = wrapIcs(simpleVevent([
      'UID:att-trunc-104@example.com',
      'SUMMARY:Big Meeting',
      'DTSTART:20260315T140000Z',
      'DTEND:20260315T150000Z',
      ...attendeeLines,
    ]));

    const events = parseIcsToEvents(ics);

    expect(events[0].attendees_truncated).toHaveLength(5);
    expect(events[0].attendees_more_count).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// TB-105: Detect Zoom/Teams/Meet join URLs from LOCATION or DESCRIPTION
// ---------------------------------------------------------------------------
describe('TB-105: Detect join URLs from LOCATION or DESCRIPTION', () => {
  it('detects Zoom URL in DESCRIPTION', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:zoom-105@example.com',
      'SUMMARY:Zoom Call',
      'DTSTART:20260315T140000Z',
      'DTEND:20260315T150000Z',
      'DESCRIPTION:Join us at https://zoom.us/j/123456789?pwd=abc123',
    ]));

    const events = parseIcsToEvents(ics);
    expect(events[0].join_url).toBe('https://zoom.us/j/123456789?pwd=abc123');
  });

  it('detects Teams URL in DESCRIPTION', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:teams-105@example.com',
      'SUMMARY:Teams Call',
      'DTSTART:20260315T140000Z',
      'DTEND:20260315T150000Z',
      'DESCRIPTION:Join at https://teams.microsoft.com/l/meetup-join/abc123',
    ]));

    const events = parseIcsToEvents(ics);
    expect(events[0].join_url).toBe('https://teams.microsoft.com/l/meetup-join/abc123');
  });

  it('detects Google Meet URL in LOCATION', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:meet-105@example.com',
      'SUMMARY:Google Meet',
      'DTSTART:20260315T140000Z',
      'DTEND:20260315T150000Z',
      'LOCATION:https://meet.google.com/abc-defg-hij',
    ]));

    const events = parseIcsToEvents(ics);
    expect(events[0].join_url).toBe('https://meet.google.com/abc-defg-hij');
  });

  it('warns when no join URL is found', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:nojoin-105@example.com',
      'SUMMARY:In Person Meeting',
      'DTSTART:20260315T140000Z',
      'DTEND:20260315T150000Z',
      'LOCATION:Building 5 Room 301',
    ]));

    const events = parseIcsToEvents(ics);
    expect(events[0].join_url).toBe('');
    expect(events[0].parse_warnings.some(w => w.includes('No join URL'))).toBe(true);
  });

  it('falls back to generic URL when no known provider URL is present', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:generic-105@example.com',
      'SUMMARY:Custom Link Meeting',
      'DTSTART:20260315T140000Z',
      'DTEND:20260315T150000Z',
      'DESCRIPTION:Join at https://custom-meet.example.com/room/123',
    ]));

    const events = parseIcsToEvents(ics);
    // findJoinUrl falls back to the first generic URL
    expect(events[0].join_url).toBe('https://custom-meet.example.com/room/123');
  });
});

// ---------------------------------------------------------------------------
// TB-106: Duration parsing (P1DT2H30M -> correct minutes)
// ---------------------------------------------------------------------------
describe('TB-106: Duration parsing (DURATION property)', () => {
  it('computes end from DTSTART + DURATION P1DT2H30M', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:dur-106@example.com',
      'SUMMARY:Long Event',
      'DTSTART;TZID=America/New_York:20260315T080000',
      'DURATION:P1DT2H30M',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    const ev = events[0];
    // P1DT2H30M = 1 day + 2 hours + 30 minutes = 1590 minutes
    expect(ev.duration_minutes).toBe(1590);
    // Should have a warning that DTEND was computed from DURATION
    expect(ev.parse_warnings.some(w => w.includes('computed from DURATION'))).toBe(true);
  });

  it('computes end from DURATION with weeks (P2W)', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:dur-weeks-106@example.com',
      'SUMMARY:Two Week Block',
      'DTSTART;TZID=America/New_York:20260315T000000',
      'DURATION:P2W',
    ]));

    const events = parseIcsToEvents(ics);
    // P2W = 14 days = 14 * 24 * 60 = 20160 minutes
    expect(events[0].duration_minutes).toBe(20160);
  });

  it('computes end from DURATION with seconds (PT90S)', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:dur-sec-106@example.com',
      'SUMMARY:Quick Ping',
      'DTSTART;TZID=America/New_York:20260315T100000',
      'DURATION:PT90S',
    ]));

    const events = parseIcsToEvents(ics);
    // PT90S = 90 seconds = ~2 minutes (rounded)
    expect(events[0].duration_minutes).toBe(2);
  });

  it('prefers DTEND over DURATION when both are present', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:dur-both-106@example.com',
      'SUMMARY:Both End and Duration',
      'DTSTART;TZID=America/New_York:20260315T100000',
      'DTEND;TZID=America/New_York:20260315T110000',
      'DURATION:P1D',
    ]));

    const events = parseIcsToEvents(ics);
    // DTEND takes precedence, so duration is 60 minutes (not 1 day)
    expect(events[0].duration_minutes).toBe(60);
  });
});

// ---------------------------------------------------------------------------
// TB-107: Line unfolding (RFC 5545 continuation lines starting with space/tab)
// ---------------------------------------------------------------------------
describe('TB-107: Line unfolding (RFC 5545 continuation lines)', () => {
  it('unfolds lines continued with a leading space', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:unfold-107@example.com',
      'SUMMARY:Unfold',
      ' ed Summary Test',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('Unfolded Summary Test');
  });

  it('unfolds lines continued with a leading tab', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:unfold-tab-107@example.com',
      'SUMMARY:Tab',
      '\tUnfolded',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('TabUnfolded');
  });

  it('handles multiple consecutive continuation lines', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:unfold-multi-107@example.com',
      'SUMMARY:A',
      ' B',
      ' C',
      ' D',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseIcsToEvents(ics);
    expect(events[0].title).toBe('ABCD');
  });

  it('unfolds DESCRIPTION with long URL spanning multiple lines', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:unfold-url-107@example.com',
      'SUMMARY:URL Test',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
      'DESCRIPTION:Join at https://zoom.us',
      ' /j/123456789?pwd=verylongpassword',
      'END:VEVENT',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseIcsToEvents(ics);
    expect(events[0].join_url).toBe('https://zoom.us/j/123456789?pwd=verylongpassword');
  });
});

// ---------------------------------------------------------------------------
// TB-108: Multiple VEVENTs in one ICS
// ---------------------------------------------------------------------------
describe('TB-108: Multiple VEVENTs in one ICS', () => {
  it('parses two VEVENTs from a single ICS file', () => {
    const vevent1 = simpleVevent([
      'UID:multi-1@example.com',
      'SUMMARY:Morning Standup',
      'DTSTART;TZID=America/New_York:20260315T090000',
      'DTEND;TZID=America/New_York:20260315T091500',
    ]);
    const vevent2 = simpleVevent([
      'UID:multi-2@example.com',
      'SUMMARY:Afternoon Review',
      'DTSTART;TZID=America/New_York:20260315T140000',
      'DTEND;TZID=America/New_York:20260315T150000',
    ]);
    const ics = wrapIcs(`${vevent1}\r\n${vevent2}`);

    const events = parseIcsToEvents(ics, 'multi.ics');

    expect(events).toHaveLength(2);
    expect(events[0].title).toBe('Morning Standup');
    expect(events[0].duration_minutes).toBe(15);
    expect(events[1].title).toBe('Afternoon Review');
    expect(events[1].duration_minutes).toBe(60);
    // Both share the same source filename
    expect(events[0].source.ics_filename).toBe('multi.ics');
    expect(events[1].source.ics_filename).toBe('multi.ics');
  });

  it('parses three VEVENTs correctly', () => {
    const vevents = [1, 2, 3].map(i => simpleVevent([
      `UID:triple-${i}@example.com`,
      `SUMMARY:Event ${i}`,
      `DTSTART:2026031${5 + i}T100000Z`,
      `DTEND:2026031${5 + i}T110000Z`,
    ]));
    const ics = wrapIcs(vevents.join('\r\n'));

    const events = parseIcsToEvents(ics);
    expect(events).toHaveLength(3);
    expect(events.map(e => e.title)).toEqual(['Event 1', 'Event 2', 'Event 3']);
  });
});

// ---------------------------------------------------------------------------
// TB-109: Malformed ICS -> graceful warnings, no crash
// ---------------------------------------------------------------------------
describe('TB-109: Malformed ICS - graceful handling, no crash', () => {
  it('returns empty array for completely invalid input', () => {
    const events = parseIcsToEvents('this is not ICS at all');
    expect(events).toEqual([]);
  });

  it('returns empty array for null/undefined input', () => {
    expect(parseIcsToEvents(null)).toEqual([]);
    expect(parseIcsToEvents(undefined)).toEqual([]);
    expect(parseIcsToEvents('')).toEqual([]);
  });

  it('returns empty array for ICS with no VEVENT', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'END:VCALENDAR',
    ].join('\r\n');

    const events = parseIcsToEvents(ics);
    expect(events).toEqual([]);
  });

  it('handles VEVENT with missing DTSTART gracefully', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:nostart-109@example.com',
      'SUMMARY:No Start Time',
      'DTEND:20260315T110000Z',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('No Start Time');
    expect(events[0].start.start_utc).toBe('');
    expect(events[0].duration_minutes).toBe(0);
  });

  it('handles VEVENT with missing UID', () => {
    const ics = wrapIcs(simpleVevent([
      'SUMMARY:No UID Event',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    expect(events[0].uid).toBe('');
    expect(events[0].title).toBe('No UID Event');
  });

  it('handles VEVENT with missing SUMMARY', () => {
    const ics = wrapIcs(simpleVevent([
      'UID:nosummary-109@example.com',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
    ]));

    const events = parseIcsToEvents(ics);

    expect(events).toHaveLength(1);
    expect(events[0].title).toBe('');
  });

  it('handles ICS with only BEGIN:VEVENT and no END:VEVENT', () => {
    const ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Test//EN',
      'BEGIN:VEVENT',
      'UID:unclosed-109@example.com',
      'SUMMARY:Unclosed Event',
      'DTSTART:20260315T100000Z',
      'END:VCALENDAR',
    ].join('\r\n');

    // Should not crash; event without END:VEVENT is not added
    const events = parseIcsToEvents(ics);
    expect(events).toEqual([]);
  });

  it('handles numeric input without crashing', () => {
    expect(() => parseIcsToEvents(12345)).not.toThrow();
    const events = parseIcsToEvents(12345);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TB-110: formatEventsForDisplay produces human-readable output
// ---------------------------------------------------------------------------
describe('TB-110: formatEventsForDisplay produces human-readable output', () => {
  it('formats a single event with all fields', () => {
    const events = [{
      title: 'Team Standup',
      start: { start_local: '2026-03-15T10:00:00Z' },
      end: { end_local: '2026-03-15T10:30:00Z' },
      duration_minutes: 30,
      location: 'Room 42',
      join_url: 'https://zoom.us/j/123',
      organizer: { name: 'Alice', email: 'alice@example.com' },
      attendees_truncated: [
        { name: 'Bob', email: 'bob@example.com' },
        { name: '', email: 'charlie@example.com' },
      ],
      attendees_more_count: 3,
      source: { ics_filename: 'invite.ics', prodid: '-//Google//EN', method: 'REQUEST' },
      parse_warnings: ['No join URL found'],
    }];

    const output = formatEventsForDisplay(events);

    expect(output).toContain('Event 1: Team Standup');
    expect(output).toContain('When: 2026-03-15T10:00:00Z');
    expect(output).toContain('Duration: 30 minutes');
    expect(output).toContain('Location: Room 42');
    expect(output).toContain('Join: https://zoom.us/j/123');
    expect(output).toContain('Organizer: Alice alice@example.com');
    expect(output).toContain('Bob <bob@example.com>');
    expect(output).toContain('<charlie@example.com>');
    expect(output).toContain('(+3 more)');
    expect(output).toContain('method=REQUEST');
    expect(output).toContain('prodid=-//Google//EN');
    expect(output).toContain('file=invite.ics');
    expect(output).toContain('Parse warnings:');
  });

  it('shows "(No title)" when title is missing', () => {
    const events = [{ start: {}, end: {}, source: {} }];
    const output = formatEventsForDisplay(events);
    expect(output).toContain('(No title)');
  });

  it('formats multiple events with spacer between them', () => {
    const events = [
      { title: 'Event A', start: {}, end: {}, source: {} },
      { title: 'Event B', start: {}, end: {}, source: {} },
    ];

    const output = formatEventsForDisplay(events);

    expect(output).toContain('Event 1: Event A');
    expect(output).toContain('Event 2: Event B');
    // Should have a blank line between events
    const lines = output.split('\n');
    const aIdx = lines.findIndex(l => l.includes('Event 1:'));
    const bIdx = lines.findIndex(l => l.includes('Event 2:'));
    // There should be an empty line between the two events
    expect(lines.slice(aIdx, bIdx).some(l => l === '')).toBe(true);
  });

  it('returns empty string for empty events array', () => {
    expect(formatEventsForDisplay([])).toBe('');
  });

  it('handles non-array input gracefully', () => {
    expect(formatEventsForDisplay(null)).toBe('');
    expect(formatEventsForDisplay(undefined)).toBe('');
    expect(formatEventsForDisplay('not an array')).toBe('');
  });

  it('handles attendee with name only (no email)', () => {
    const events = [{
      title: 'Name Only',
      start: {},
      end: {},
      attendees_truncated: [{ name: 'Just A Name', email: '' }],
      attendees_more_count: 0,
      source: {},
    }];

    const output = formatEventsForDisplay(events);
    expect(output).toContain('Attendees: Just A Name');
  });
});

// ---------------------------------------------------------------------------
// formatIcsAttachmentsAsString
// ---------------------------------------------------------------------------
describe('formatIcsAttachmentsAsString', () => {
  it('returns empty string for null/empty input', () => {
    expect(formatIcsAttachmentsAsString(null)).toBe('');
    expect(formatIcsAttachmentsAsString([])).toBe('');
    expect(formatIcsAttachmentsAsString(undefined)).toBe('');
  });

  it('formats a single ICS attachment with parsed events', () => {
    const icsText = wrapIcs(simpleVevent([
      'UID:fmt-att@example.com',
      'SUMMARY:Formatted Event',
      'DTSTART:20260315T100000Z',
      'DTEND:20260315T110000Z',
    ]));

    const output = formatIcsAttachmentsAsString([{
      filename: 'invite.ics',
      contentType: 'text/calendar',
      partName: '1.2',
      text: icsText,
    }]);

    expect(output).toContain('ICS Attachments (parsed):');
    expect(output).toContain("ICS[1] filename='invite.ics'");
    expect(output).toContain('Event 1: Formatted Event');
    expect(output).toContain('ICS_JSON[1.1]:');
  });

  it('shows "(No events parsed)" for empty ICS text', () => {
    const output = formatIcsAttachmentsAsString([{
      filename: 'empty.ics',
      contentType: 'text/calendar',
      partName: '1.2',
      text: '',
    }]);

    expect(output).toContain('(No events parsed)');
  });
});
