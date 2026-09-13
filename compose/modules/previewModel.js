/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

var TabMail = TabMail || {};

Object.assign(TabMail, {
  /**
   * Project the existing sentence diff onto one atomic preview. Offsets refer
   * to the unchanged editor, never to preview DOM. Adjacent deletes/inserts
   * are one replacement; context is not part of the acceptance payload.
   */
  buildPreviewModel(original, corrected, cursor) {
    const diffs = TabMail.computeDiff(original, corrected, cursor);
    const filtered = TabMail._filterDiffsForSuggestion(diffs, original, corrected, cursor);
    const edits = [];
    let offset = 0;
    let pending = null;
    for (const [op, text] of filtered.diffs) {
      if (op === 0) {
        if (pending) edits.push(pending);
        pending = null;
        offset += text.length;
      } else {
        if (!pending) pending = { start: offset, end: offset, text: '' };
        if (op === -1) {
          offset += text.length;
          pending.end = offset;
        } else if (op === 1) {
          pending.text += text;
        }
      }
    }
    if (pending) edits.push(pending);
    if (!edits.length) return { edits, jumpOffset: filtered.firstDiffPosition };

    const sentences = TabMail.splitIntoSentences(original);
    const index = TabMail.findSentenceContainingCursor(sentences, cursor);
    let start = index < 0 ? 0 : TabMail.getSentenceStartOffset(original, index);
    let end = index < 0 ? original.length : start + sentences[index].length;
    start = Math.min(start, edits[0].start);
    end = Math.max(end, edits[edits.length - 1].end);
    const runs = [];
    let pos = start;
    for (const edit of edits) {
      if (edit.start > pos) runs.push({ text: original.slice(pos, edit.start), inserted: false });
      if (edit.text) runs.push({ text: edit.text, inserted: true });
      pos = edit.end;
    }
    if (pos < end) runs.push({ text: original.slice(pos, end), inserted: false });
    return { original, start, end, edits, runs, replacement: runs.map(run => run.text).join(''), jumpOffset: null };
  },
});
