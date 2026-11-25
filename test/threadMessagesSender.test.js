/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// threadMessagesSender.test.js — the threadMessages experiment names each thread
// message's sender with Thunderbird's own parser (headerParser.parseEncodedHeaderW on
// the message header's raw From value): the name, else the address, else "Unknown".

import { describe, expect, it } from 'vitest';
import { experimentFunctions } from './helpers/experimentFunctions.js';
import { parseEncodedHeaderW } from './helpers/tbAddressParser.js';

const EXPERIMENT = new URL('../theme/experiments/threadMessages/threadMessages.sys.mjs', import.meta.url);

const { formatSender } = experimentFunctions(EXPERIMENT, ['formatSender'], {
  MailServicesThreadMessages: { headerParser: { parseEncodedHeaderW } },
});

describe('threadMessages formatSender', () => {
  it.each([
    ['"Me <me@example.com>" <other@example.net>', 'Me <me@example.com>'],
    ['"Doe, John" <john@example.com>', 'Doe, John'],
    ['Ann <a@example.com>', 'Ann'],
    ['=?UTF-8?Q?Ren=C3=A9?= <r@example.com>', 'René'],
    ['=?UTF-8?Q?No_Reply_<noreply@example.com>?= <person@example.net>', 'No Reply <noreply@example.com>'],
    ['person@example.net (Person)', 'Person'],
    ['person@example.net', 'person@example.net'],
    ['Team: a@example.com, b@example.com;', 'a@example.com'],
    ['', 'Unknown'],
  ])('From: %s → %s', (rawFrom, expected) => {
    expect(formatSender({ author: rawFrom })).toBe(expected);
  });

  it('names a header with no author "Unknown"', () => {
    expect(formatSender({})).toBe('Unknown');
    expect(formatSender(null)).toBe('Unknown');
  });
});
