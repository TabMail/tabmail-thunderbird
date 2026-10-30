/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptsMarkdown.test.js — prompts/modules/markdown.js: how the prompts page reads a stored text into
// the sections it shows (pageSections), and the one-line changes it makes to it (removeItem, addItems,
// replaceItems). Each change touches exactly the line or section acted on; every other line, the field's
// head and footer included, comes back byte for byte.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { addItems, pageSections, removeItem, replaceItems } from '../prompts/modules/markdown.js';

const END = '====END USER INSTRUCTIONS====';
const header = (name) => `# ${name} (DO NOT EDIT/DELETE THIS SECTION HEADER)`;
const bundled = (field) => readFileSync(new URL(`../prompts/user_${field}.md`, import.meta.url), 'utf8');
const items = (section) => section.items.map((item) => item.text);
const shown = (field, text) => pageSections(field, text).map((section) => [section.key, section.copy, items(section)]);

const COMPOSITION = [
  'Head line.',
  '',
  header('General writing style'),
  '- Dash rule.',
  '## Hash line',
  '',
  '   - Padded rule.   ',
  header('Language'),
  '- English.',
  '',
  END,
  'Closing line.',
].join('\n');

describe('the sections the page shows (pageSections)', () => {
  it('are the field\'s own headers, each with every non-empty line after it as an item, "- " dropped and trimmed', () => {
    expect(shown('composition', COMPOSITION)).toEqual([
      ['general', 0, ['Dash rule.', '## Hash line', 'Padded rule.']],
      ['language', 0, ['English.']],
    ]);
    const [general] = pageSections('composition', COMPOSITION);
    expect(general).toMatchObject({ title: 'General writing style', header: 2 });
    expect(general.items.map((item) => item.line)).toEqual([3, 4, 6]);
  });

  it('show nothing of the head, or of an exact or padded END line and what follows it', () => {
    for (const end of [END, `   ${END}   `]) {
      const text = [header('General writing style'), '- Rule.', end, '- After the end.', header('Language'), '- Hidden.'].join('\n');
      expect(shown('composition', text)).toEqual([['general', 0, ['Rule.']]]);
    }
  });

  it('show a line merely holding the END text, or a header mark under a name the field does not have, as an item', () => {
    const text = [header('General writing style'), `- Sign off with ${END} here.`, header('Custom rule'), '- After.'].join('\n');
    expect(shown('composition', text)).toEqual([['general', 0, [`Sign off with ${END} here.`, header('Custom rule'), 'After.']]]);
  });

  it('count a section shown twice as its second copy', () => {
    const text = [header('Language'), '- One.', header('General writing style'), '- Two.', header('Language'), '- Three.'].join('\n');
    expect(shown('composition', text)).toEqual([['language', 0, ['One.']], ['general', 0, ['Two.']], ['language', 1, ['Three.']]]);
  });

  it('are one section without a header for the knowledge base, a marked line or END line among its items', () => {
    expect(shown('kb', `- One.\n\n${END}\n${header('Language')}`)).toEqual([['', 0, ['One.', END, header('Language')]]]);
    expect(shown('kb', '')).toEqual([['', 0, []]]);
  });

  it('split lines as the store does, on "\\r\\n" and "\\r" too', () => {
    expect(shown('kb', '- One\r\n- Two\rThree')).toEqual([['', 0, ['One', 'Two', 'Three']]]);
  });

  it('read the bundled texts as their sections, with the bundled rules', () => {
    for (const field of ['composition', 'action']) {
      const sections = pageSections(field, bundled(field));
      expect(sections.length).toBeGreaterThan(1);
      expect(sections.every((section) => section.copy === 0)).toBe(true);
    }
  });
});

describe('removing an item (removeItem)', () => {
  it('removes exactly its line, every other line kept byte for byte', () => {
    const after = removeItem('composition', COMPOSITION, { key: 'general', copy: 0, text: '## Hash line' });
    expect(after).toBe(COMPOSITION.split('\n').filter((line) => line !== '## Hash line').join('\n'));
  });

  it('finds the item by its text when the lines moved since it was shown', () => {
    const moved = COMPOSITION.replace('- Dash rule.\n', '- Dash rule.\n- Arrived meanwhile.\n');
    const after = removeItem('composition', moved, { key: 'general', copy: 0, text: '## Hash line' });
    expect(after).toBe(moved.split('\n').filter((line) => line !== '## Hash line').join('\n'));
  });

  it('removes from the copy acted on only', () => {
    const text = [header('Language'), '- Same.', header('General writing style'), header('Language'), '- Same.'].join('\n');
    expect(removeItem('composition', text, { key: 'language', copy: 1, text: 'Same.' })).toBe([header('Language'), '- Same.', header('General writing style'), header('Language')].join('\n'));
  });

  it('is null when the item or its section is gone', () => {
    expect(removeItem('composition', COMPOSITION, { key: 'general', copy: 0, text: 'Not there.' })).toBeNull();
    expect(removeItem('composition', COMPOSITION, { key: 'language', copy: 1, text: 'English.' })).toBeNull();
  });

  it('removes a knowledge-base line', () => {
    expect(removeItem('kb', '- One\n- Two\n- Three', { key: '', copy: 0, text: 'Two' })).toBe('- One\n- Three');
  });
});

describe('adding items (addItems)', () => {
  it('adds a "- " line right after the section\'s last item, every other line kept', () => {
    const after = addItems('composition', COMPOSITION, { key: 'general', copy: 0 }, ['New rule.']).split('\n');
    expect(after.filter((line) => line !== '- New rule.')).toEqual(COMPOSITION.split('\n'));
    expect(after.indexOf('- New rule.')).toBe(after.indexOf('   - Padded rule.   ') + 1);
  });

  it('adds right after the header of a section without items, and to the copy acted on', () => {
    const text = [header('Language'), header('General writing style'), '- Two.', header('Language'), '- Three.'].join('\n');
    expect(addItems('composition', text, { key: 'language', copy: 0 }, ['New.'])).toBe([header('Language'), '- New.', header('General writing style'), '- Two.', header('Language'), '- Three.'].join('\n'));
    expect(addItems('composition', text, { key: 'language', copy: 1 }, ['New.'])).toBe(`${text}\n- New.`);
  });

  it('adds to an empty or a filled knowledge base', () => {
    expect(addItems('kb', '', { key: '', copy: 0 }, ['First.'])).toBe('- First.');
    expect(addItems('kb', '- One\n', { key: '', copy: 0 }, ['Two'])).toBe('- One\n- Two\n');
  });

  it('is null when the section is gone', () => {
    expect(addItems('composition', COMPOSITION, { key: 'links', copy: 0 }, ['New.'])).toBeNull();
  });
});

describe('replacing a section\'s items (replaceItems)', () => {
  it('puts the given lines where the section\'s items were, every other line kept', () => {
    const after = replaceItems('composition', COMPOSITION, { key: 'general', copy: 0 }, ['Default one.', 'Default two.']);
    expect(after).toBe(['Head line.', '', header('General writing style'), '- Default one.', '- Default two.', '', header('Language'), '- English.', '', END, 'Closing line.'].join('\n'));
  });

  it('fills a section without items right after its header, and replaces only the copy acted on', () => {
    const text = [header('Language'), '- One.', header('General writing style'), header('Language'), '- Three.'].join('\n');
    expect(replaceItems('composition', text, { key: 'language', copy: 1 }, ['D.'])).toBe([header('Language'), '- One.', header('General writing style'), header('Language'), '- D.'].join('\n'));
    expect(replaceItems('composition', text, { key: 'general', copy: 0 }, ['D.'])).toBe([header('Language'), '- One.', header('General writing style'), '- D.', header('Language'), '- Three.'].join('\n'));
  });

  it('is null when the section is gone', () => {
    expect(replaceItems('composition', COMPOSITION, { key: 'language', copy: 1 }, ['D.'])).toBeNull();
  });
});
