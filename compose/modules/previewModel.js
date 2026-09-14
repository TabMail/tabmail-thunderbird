/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

var TabMail = TabMail || {};

Object.assign(TabMail, {
  previousAcceptedSentence(current) {
    const previous = TabMail.state.lastAcceptedText;
    if (!previous || !current.trim() || previous === current) return '';
    let start = 0;
    while (start < previous.length && start < current.length && previous[start] === current[start]) start++;
    let oldEnd = previous.length, newEnd = current.length;
    while (oldEnd > start && newEnd > start && previous[oldEnd - 1] === current[newEnd - 1]) { oldEnd--; newEnd--; }
    // Only offer history for a small change inside an existing word, never
    // for new sentences, whole-word replacements, or deleted prose.
    if (!/[\p{L}\p{M}]/u.test(previous[start - 1] || '') && !/[\p{L}\p{M}]/u.test(previous[oldEnd] || '')) return '';
    if (!/^[\p{L}\p{M}]*$/u.test(previous.slice(start, oldEnd)) || !/^[\p{L}\p{M}]*$/u.test(current.slice(start, newEnd))) return '';
    const limits = TabMail.config.correctionContext;
    if (Math.max(oldEnd - start, newEnd - start) > limits.maxEditLength) return '';
    const sentences = TabMail.splitIntoSentences(previous);
    const index = TabMail.findSentenceContainingCursor(sentences, start);
    if (index < 0) return '';
    const sentence = sentences[index];
    const end = TabMail.getSentenceStartOffset(previous, index) + sentence.length;
    if (oldEnd > end || sentence.length > limits.maxSentenceLength) return '';
    return sentence.trim();
  },

  composeEditsFromDiff(diffs) {
    const edits = [];
    let offset = 0;
    let pending = null;
    for (const [op, text] of diffs) {
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
    return edits;
  },

  /**
   * Project the existing sentence diff onto one atomic preview. Offsets refer
   * to the unchanged editor, never to preview DOM. Adjacent deletes/inserts
   * are one replacement; context is not part of the acceptance payload.
   */
  buildPreviewModel(original, corrected, cursor, blockBreaks = []) {
    let diffs = TabMail.computeDiff(original, corrected, cursor);
    // A sentence correction may replace trailing layout whitespace with a space.
    // Preserve HTML paragraph boundaries; they are not editable text characters.
    if (blockBreaks.length) {
      const proposed = TabMail.composeEditsFromDiff(diffs);
      let changed = false;
      for (const edit of proposed) {
        // A plain-text response commonly spells an existing HTML paragraph gap
        // as two newlines. The projection already supplies its block separator;
        // materializing the second one inserts a stray BR between paragraphs.
        // Consume only that redundant separator, never authored BRs, plaintext
        // newlines, or additional intentional blank lines in the proposal.
        if (edit.start === edit.end && blockBreaks.includes(edit.start - 1) && /^\n+$/.test(edit.text)) {
          edit.text = edit.text.slice(1);
          changed = true;
        }
        const boundary = blockBreaks.find(offset => offset >= edit.start && offset < edit.end && /^\s*$/.test(original.slice(offset, edit.end)));
        if (boundary !== undefined && /\s$/.test(edit.text)) {
          edit.end = boundary;
          edit.text = edit.text.trimEnd();
          changed = true;
        }
      }
      if (changed) {
        corrected = proposed.reduceRight((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), original);
        diffs = TabMail.computeDiff(original, corrected, cursor);
      }
    }
    const filtered = TabMail._filterDiffsForSuggestion(diffs, original, corrected, cursor);
    const edits = TabMail.composeEditsFromDiff(filtered.diffs);
    if (!edits.length) return { edits, jumpOffset: filtered.firstDiffPosition };
    // Existing drafts offer only the next appended sentence. Empty drafts keep
    // the complete initial proposal; leading paragraph spacing belongs to it.
    const tail = edits[edits.length - 1];
    if (original.trim() && tail.start === original.length && tail.end === original.length) {
      let next = '';
      for (const part of TabMail.splitIntoSentences(tail.text)) {
        next += part;
        if (part.trim()) break;
      }
      tail.text = next;
    }

    const sentences = TabMail.splitIntoSentences(original);
    const index = TabMail.findSentenceContainingCursor(sentences, cursor);
    let start = index < 0 ? 0 : TabMail.getSentenceStartOffset(original, index);
    let end = index < 0 ? original.length : start + sentences[index].length;
    start = Math.min(start, edits[0].start);
    end = Math.max(end, edits[edits.length - 1].end);
    const runs = [];
    let pos = start;
    for (const edit of edits) {
      if (edit.start > pos) runs.push({ text: original.slice(pos, edit.start), inserted: false, start: pos });
      if (edit.text) runs.push({ text: edit.text, inserted: true, start: edit.start });
      pos = edit.end;
    }
    if (pos < end) runs.push({ text: original.slice(pos, end), inserted: false, start: pos });
    return { original, start, end, edits, runs, replacement: runs.map(run => run.text).join(''), jumpOffset: null };
  },
});
