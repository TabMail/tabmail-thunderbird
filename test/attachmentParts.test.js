/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// Thunderbird's message reader leaves the paperclip off for vCards and PGP keys
// (msgHdrView.js markHasAttachments); hasPaperclipAttachment follows the same rule.

import { describe, expect, it } from 'vitest';
import { attachmentNamesText, hasPaperclipAttachment } from '../agent/modules/attachmentParts.js';

const file = (contentType) => ({ name: 'f', contentType, size: 1 });

describe('hasPaperclipAttachment', () => {
  it.each(['text/vcard', 'text/x-vcard', 'application/pgp-keys', 'Text/VCard', 'APPLICATION/PGP-KEYS'])(
    'does not count a lone %s part',
    (contentType) => { expect(hasPaperclipAttachment([file(contentType)])).toBe(false); },
  );

  it('counts any other file, also next to an excluded one', () => {
    expect(hasPaperclipAttachment([file('application/pdf')])).toBe(true);
    expect(hasPaperclipAttachment([file('text/x-vcard'), file('application/pdf')])).toBe(true);
    expect(hasPaperclipAttachment([file('application/pgp-keys'), file('')])).toBe(true);
  });

  it('counts nothing for no files', () => {
    expect(hasPaperclipAttachment([])).toBe(false);
  });
});

describe('attachmentNamesText', () => {
  const named = (...names) => names.map(name => ({ name, contentType: 'application/pdf', size: 1 }));

  it('puts each file on its own line and leaves out files without a name', () => {
    expect(attachmentNamesText(named('report.pdf', '', 'notes.txt'))).toBe('report.pdf\nnotes.txt');
  });

  it('adds the words of a name written as one run, so each word can be searched', () => {
    expect(attachmentNamesText(named('TaxReceipt2024.pdf'))).toBe('TaxReceipt2024.pdf Tax Receipt 2024.pdf');
    expect(attachmentNamesText(named('PDFReport.pdf'))).toBe('PDFReport.pdf PDF Report.pdf');
    expect(attachmentNamesText(named('Q4-Übersicht.pdf'))).toBe('Q4-Übersicht.pdf Q 4-Übersicht.pdf');
  });

  it('stores nothing when no file has a name', () => {
    expect(attachmentNamesText([])).toBe('');
    expect(attachmentNamesText(named(''))).toBe('');
  });
});
