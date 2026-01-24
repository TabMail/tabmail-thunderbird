var TabMail = TabMail || {};

Object.assign(TabMail, {
  /**
   * Tokenize text for token-level diffing.
   * Rules:
   * - Preserve "\n" as standalone tokens.
   * - Group spaces, tabs, NBSP into single whitespace tokens.
   * - Group alphanumerics and selected word chars into word tokens.
   * - All other characters become single-character punctuation tokens.
   * @param {string} text
   * @returns {string[]} tokens
   */
  getTokenParts(text) {
    try {
      if (typeof text !== "string" || text.length === 0) return [];

      const cfg = (TabMail.config && TabMail.config.tokens) || {};
      const tokens = [];
      const n = text.length;

      function isSpaceNoNewline(ch) {
        return ch === " " || ch === "\t" || ch === "\u00A0";
      }

      function isWordChar(ch) {
        if (!ch) return false;
        const code = ch.codePointAt(0);
        if (code === undefined) return false;
        // Basic letters/digits and underscore
        if ((code >= 48 && code <= 57) || // 0-9
            (code >= 65 && code <= 90) || // A-Z
            (code >= 97 && code <= 122) || // a-z
            ch === "_") {
          return true;
        }
        // Treat non-ASCII as word to keep CJK runs together
        return code > 127;
      }

      function tokenHasWordChar(tok) {
        if (typeof tok !== "string" || tok.length === 0) return false;
        for (let idx = 0; idx < tok.length; idx++) {
          if (isWordChar(tok[idx])) return true;
        }
        return false;
      }

      // --- Stage 1: split into word runs and single-character delimiters ---
      const stage1 = [];
      let i = 0;
      while (i < n) {
        const ch = text[i];
        if (isWordChar(ch)) {
          let j = i + 1;
          while (j < n && isWordChar(text[j])) j++;
          stage1.push(text.slice(i, j));
          i = j;
        } else {
          // Non-word is a single-character delimiter/punctuation/newline
          stage1.push(ch);
          i += 1;
        }
      }

      // Skip merging pass for now
      return stage1;

      // --- Stage 2: merging pass ---
      // Rules:
      // - If token is "\n": always emit as its own token.
      // - If token is a non-newline delimiter (length 1, non-word char):
      //   * If previous output token contains a word char, merge this one char into it.
      //   * Else, coalesce consecutive non-newline delimiters into one token.
      // - If token is a word run: emit as-is.
      for (let t of stage1) {
        if (t === "\n") {
          tokens.push("\n");
          continue;
        }
        if (!tokenHasWordChar(t)) {
          // t is a single non-word character (since stage1 ensures length===1 for non-word)
          const prevIdx = tokens.length - 1;
          if (prevIdx >= 0 && tokenHasWordChar(tokens[prevIdx])) {
            tokens[prevIdx] += t;
          } else {
            const prev = tokens[prevIdx];
            if (prevIdx >= 0 && typeof prev === "string" && prev !== "\n" && !tokenHasWordChar(prev)) {
              tokens[prevIdx] = prev + t; // coalesce consecutive non-newline delimiters
            } else {
              tokens.push(t);
            }
          }
          continue;
        }
        // Word run
        tokens.push(t);
      }

      if (cfg.logSample) {
        try {
          const sample = tokens.slice(0, 20);
          TabMail.log.debug('diff', "Tokens getTokenParts sample", { count: tokens.length, sample });
        } catch (_) {}
      }

      return tokens;
    } catch (e) {
      try {
        console.warn("[TabMail Tokens] getTokenParts failed; returning []", e);
      } catch (_) {}
      return [];
    }
  },
});


