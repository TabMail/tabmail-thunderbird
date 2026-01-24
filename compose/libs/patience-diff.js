// Based on a ChatGPT-generated reference implementation of Patience Diff from the algorithm.

// Expose on TabMail namespace to match the rest of the compose libs environment.
var TabMail = TabMail || {};

(function attachPatienceDiff(ns) {
  if (ns.patienceDiffArray) {
    return; // already attached
  }

  function uniqueMap(xs) {
    const map = new Map();
    for (let i = 0; i < xs.length; i++) {
      const k = xs[i];
      const v = map.get(k) || { count: 0, idx: i };
      v.count++;
      map.set(k, v);
    }
    return map;
  }

  // Internal: find anchor pairs via LIS over unique matches within slices
  function computeAnchors(a, b, aLo, aHi, bLo, bHi, eq) {
    const aSlice = a.slice(aLo, aHi);
    const bSlice = b.slice(bLo, bHi);

    const aU = uniqueMap(aSlice);
    const bU = uniqueMap(bSlice);

    const pairs = [];
    for (let i = 0; i < aSlice.length; i++) {
      const vA = aU.get(aSlice[i]);
      if (!vA || vA.count !== 1) continue;
      for (let j = 0; j < bSlice.length; j++) {
        const vB = bU.get(bSlice[j]);
        if (!vB || vB.count !== 1) continue;
        if (eq ? eq(aSlice[i], bSlice[j]) : aSlice[i] === bSlice[j]) {
          pairs.push([aLo + i, bLo + j]);
        }
      }
    }

    // Sort by a-index; take LIS on b-index
    pairs.sort((p, q) => p[0] - q[0]);
    const tails = [];
    const prev = Array(pairs.length).fill(-1);
    const pos = [];

    for (let i = 0; i < pairs.length; i++) {
      const bIdx = pairs[i][1];
      let lo = 0, hi = tails.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (tails[mid][1] < bIdx) lo = mid + 1; else hi = mid;
      }
      if (lo === tails.length) tails.push(pairs[i]); else tails[lo] = pairs[i];
      pos[lo] = i;
      if (lo > 0) prev[i] = pos[lo - 1];
    }

    const out = [];
    if (tails.length) {
      let p = pos[tails.length - 1];
      while (p >= 0) {
        out.push(pairs[p]);
        p = prev[p];
      }
      out.reverse();
    }
    return out;
  }

  /**
   * Patience diff over arrays.
   * Returns a sequence of blocks: objects { op, a, b } where
   *   - op === 0: equality; a and b are arrays with a single equal item
   *   - op === -1: deletions; a is array of items; b is []
   *   - op === 1: insertions; a is []; b is array of items
   *
   * @param {any[]} a
   * @param {any[]} b
   * @param {(x:any,y:any)=>boolean} eq optional equality
   * @returns {Array<{op:number,a:any[],b:any[]}>}
   */
  function patienceDiffArray(a, b, eq) {
    const result = [];
    function recurse(aLo, aHi, bLo, bHi) {
      const ancs = computeAnchors(a, b, aLo, aHi, bLo, bHi, eq);
      if (ancs.length === 0) {
        if (aLo < aHi) result.push({ op: -1, a: a.slice(aLo, aHi), b: [] });
        if (bLo < bHi) result.push({ op: 1, a: [], b: b.slice(bLo, bHi) });
        return;
      }
      // Pre-anchor gap
      const [aA0, bA0] = ancs[0];
      recurse(aLo, aA0, bLo, bA0);
      // Anchors and gaps between them
      for (let k = 0; k < ancs.length; k++) {
        const [ai, bi] = ancs[k];
        result.push({ op: 0, a: [a[ai]], b: [b[bi]] });
        const nextA = k + 1 < ancs.length ? ancs[k + 1][0] : aHi;
        const nextB = k + 1 < ancs.length ? ancs[k + 1][1] : bHi;
        recurse(ai + 1, nextA, bi + 1, nextB);
      }
    }

    recurse(0, a.length, 0, b.length);
    return result;
  }

  ns.patienceDiffArray = patienceDiffArray;
})(TabMail);


