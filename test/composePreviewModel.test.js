/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, it, expect } from 'vitest';

function load() {
  const context = createContext({ console, TabMail: { config: {
    dmpEditCost: 10, dmpCheckLines: true, diffGroupBySentence: true,
  } } });
  for (const name of ['libs/jsdiff.min.js', 'libs/diff-match-patch.js', 'modules/tokens.js', 'modules/sentences.js', 'modules/diff.js', 'modules/previewModel.js']) {
    runInContext(readFileSync(resolve('compose', name), 'utf8'), context);
  }
  return context.TabMail;
}

describe('atomic contextual preview model', () => {
  it('accepts the whole empty-draft suggestion, with every proposed word marked inserted', () => {
    const tm = load();
    const proposed = 'Hello Alex,\n\nHere is the proposal.\n\nBest,\nSam';
    const result = tm.buildPreviewModel('', proposed, 0);
    expect(result.replacement).toBe(proposed);
    expect(result.edits).toEqual([{ start: 0, end: 0, text: proposed }]);
    expect(result.runs.every(run => run.inserted)).toBe(true);
  });
  it('keeps surrounding sentences out of the atomic edit', () => {
    const tm = load();
    const original = 'Hello. I can send it next week. Thank you.';
    const proposed = 'Hello. I can send it Thursday. Thank you.';
    const result = tm.buildPreviewModel(original, proposed, 18);
    let applied = original;
    for (const edit of [...result.edits].reverse()) applied = applied.slice(0, edit.start) + edit.text + applied.slice(edit.end);
    expect(applied).toBe(proposed);
    expect(result.replacement).toBe('I can send it Thursday. ');
    expect(result.runs.filter(run => run.inserted).map(run => run.text).join('')).not.toContain('next week');
  });
  it('keeps the same scope and wording as the caret moves within the sentence', () => {
    const tm = load();
    const original = 'Hello. I can send it next week. Thank you.';
    const proposed = 'Hello. I can send it Thursday. Thank you.';
    const first = tm.buildPreviewModel(original, proposed, 8);
    const second = tm.buildPreviewModel(original, proposed, 25);
    expect(second).toEqual(first);
  });
  it('represents a deletion-only edit without inventing inserted words', () => {
    const tm = load();
    const result = tm.buildPreviewModel('This is very useful.', 'This is useful.', 10);
    expect(result.replacement).toBe('This is useful.');
    expect(result.edits.some(edit => edit.end > edit.start)).toBe(true);
    expect(result.runs.some(run => run.inserted)).toBe(false);
  });
  it('offers a jump when the available edit belongs to a different sentence', () => {
    const tm = load();
    const result = tm.buildPreviewModel('Hello. This is bad.', 'Hello. This is good.', 1);
    expect(result.edits).toEqual([]);
    expect(result.jumpOffset).toBeGreaterThan(6);
  });
});


it('keeps a next-sentence continuation in the whole suggestion', () => {
  const tm = load();
  const original = 'The holiday starts tomorrow.';
  const proposed = 'The holiday starts tomorrow. I will be back on Monday.';
  const result = tm.buildPreviewModel(original, proposed, original.length);
  const actual = result.edits.reduceRight((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), original);
  expect(actual).toBe(proposed);
  expect(result.runs.filter(run => run.inserted).map(run => run.text).join('')).toContain('I will be back on Monday.');
});

it.each([
 ['The holiday starts tomorrow.',' I return Monday. Call me Tuesday.',' I return Monday. '],
 ['This is a test. We',' will meet Monday. Bring notes. Thanks.',' will meet Monday. '],
 ['Hi Alex,\n','\nI return Monday. Call me Tuesday.','\nI return Monday. '],
])('limits the appended proposal to the next sentence after %s',(original,tail,expected)=>{
 const tm=load(),result=tm.buildPreviewModel(original,original+tail,original.length);
 expect(result.edits).toEqual([{start:original.length,end:original.length,text:expected}]);
 expect(result.runs.filter(run=>run.inserted).map(run=>run.text).join('')).toBe(expected);
 expect(result.edits.reduceRight((text,edit)=>text.slice(0,edit.start)+edit.text+text.slice(edit.end),original)).toBe(original+expected);
});
it('keeps a full initial suggestion when the draft contains only whitespace',()=>{
 const tm=load(),original='\n',proposed='Hello Alex. Here is the plan. Thank you.';
 const model=tm.buildPreviewModel(original,proposed,original.length);
 expect(model.edits.reduceRight((text,edit)=>text.slice(0,edit.start)+edit.text+text.slice(edit.end),original)).toBe(proposed);
});
