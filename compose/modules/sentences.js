var TabMail = TabMail || {};

Object.assign(TabMail, {
  

  /**
   * Splits text into sentence parts using the centralized regex. This wraps
   * the common `text.match(regex)` usage so all callers use a single API.
   * @param {string} text
   * @returns {string[]} Array of fragments (may be empty)
   */
  getSentenceParts(text) {
    try {
      // Delimiters: newline always breaks. Punctuation (., !, ?) only
      // breaks if followed by space/newline or end-of-text when
      // `requireSpaceAfterPunct` is enabled (default true).
      //
      // Previous regex (kept for reference):
      // - Attaches preceding newlines to the following sentence
      // - Prefers punctuation termination before newline termination
      // - Allows last token to be end-of-string
      // const OLD_REGEX = /\n*(?:[^\n]+?[.!?]|[^\n]*?\n|[^\n]+(?=$))/g;
      if (typeof text !== "string" || text.length === 0) return [];
      const out = [];
      const n = text.length;
      let start = 0;
      let i = 0;

      function isSpaceNoNewline(ch) {
        return ch === " " || ch === "\t" || ch === "\u00A0";
      }

      while (i < n) {
        const ch = text[i];

        // Newline: always close the token including the newline
        if (ch === "\n") {
          const token = text.slice(start, i + 1);
          if (token) out.push(token);
          i += 1;
          start = i;
          continue;
        }

        const isPunct = ch === "." || ch === "!" || ch === "?";
        if (isPunct) {
          const next = i + 1 < n ? text[i + 1] : "";
          const boundaryOK = (next === "" || next === "\n" || isSpaceNoNewline(next));

          if (boundaryOK) {
            // Include punctuation and any immediate spaces, and merge a single
            // following newline into the same token if present.
            let j = i + 1;
            while (j < n && isSpaceNoNewline(text[j])) j++;
            if (j < n && text[j] === "\n") j++;

            const token = text.slice(start, j);
            if (token) out.push(token);
            i = j;
            start = i;
            continue;
          }
        }

        // No boundary at this position; advance.
        i += 1;
      }

      // Remainder
      if (start < n) {
        out.push(text.slice(start));
      }
      return out;
    } catch (e) {
      try {
        console.warn("[TabMail Sentences] getSentenceParts failed; returning []", e);
      } catch (_) {}
      return [];
    }
  },
  /**
   * Splits text into sentences using the same regex as the diff computation.
   * @param {string} text The text to split.
   * @returns {string[]} Array of sentence fragments.
   */
  splitIntoSentences(text) {
    // // Use centralized helper to ensure identical boundaries everywhere.
    // // Unconditional entry log so we can always verify execution
    // try {
    //   console.log("[TabMail Sentences] splitIntoSentences invoked", {
    //     textLength: typeof text === "string" ? text.length : 0,
    //   });
    // } catch (_) {}

    const raw = TabMail.getSentenceParts(text);

    return raw;
  },

  /**
   * Finds which sentence contains the given cursor position.
   * @param {string[]} sentences The sentences to search through.
   * @param {number} cursorPosition The cursor position.
   * @returns {number} Index of the sentence containing the cursor, or -1 if not found.
   */
  findSentenceContainingCursor(sentences, cursorPosition) {
    let accum = 0;

    for (let i = 0; i < sentences.length; i++) {
      const sentence = sentences[i];
      const sentenceLength = sentence.length;

      if (accum <= cursorPosition && cursorPosition < accum + sentenceLength) {
        return i;
      }
      accum += sentenceLength;
    }

    // If cursor is at the very end, return the last sentence
    if (cursorPosition >= accum && sentences.length > 0) {
      return sentences.length - 1;
    }

    return -1;
  },

  /**
   * Gets the character offset where a sentence starts in the full text.
   * @param {string} text The full text.
   * @param {number} sentenceIndex The index of the sentence.
   * @returns {number} Character offset where the sentence starts.
   */
  getSentenceStartOffset(text, sentenceIndex) {
    const sentences = TabMail.splitIntoSentences(text);
    let offset = 0;

    for (let i = 0; i < sentenceIndex; i++) {
      offset += sentences[i].length;
    }

    return offset;
  },
}); 