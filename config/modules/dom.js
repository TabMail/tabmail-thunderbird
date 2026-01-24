export function $(id) {
  return document.getElementById(id);
}

// Plain text editor – no inline decorations
export function _extractEditableRegion(fullText, beginMarker, endMarker) {
  const lines = (fullText || "").split(/\r?\n/);
  const startIdx = lines.findIndex((l) => l.includes(beginMarker));
  const endIdx = lines.findIndex((l) => l.includes(endMarker));
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    // fallback to all content if markers missing
    return { editable: fullText || "", prefix: "", suffix: "" };
  }
  const prefix = lines.slice(0, startIdx + 1).join("\n");
  const suffix = lines.slice(endIdx).join("\n");
  const editable = lines.slice(startIdx + 1, endIdx).join("\n");
  return { editable, prefix, suffix };
}

// Scroll position preservation helpers
export function saveScrollPosition() {
  return {
    windowScrollY: window.scrollY,
    windowScrollX: window.scrollX,
    documentScrollTop: document.documentElement.scrollTop,
    documentScrollLeft: document.documentElement.scrollLeft,
    bodyScrollTop: document.body.scrollTop,
    bodyScrollLeft: document.body.scrollLeft,
  };
}

export function restoreScrollPosition(scrollPos) {
  if (!scrollPos) return;
  try {
    // Use requestAnimationFrame to ensure DOM updates are complete
    requestAnimationFrame(() => {
      // Try multiple restoration methods for cross-browser compatibility
      if (scrollPos.windowScrollY !== undefined) {
        window.scrollTo(scrollPos.windowScrollX || 0, scrollPos.windowScrollY);
      }
      if (scrollPos.documentScrollTop !== undefined) {
        document.documentElement.scrollTop = scrollPos.documentScrollTop;
        document.documentElement.scrollLeft = scrollPos.documentScrollLeft || 0;
      }
      if (scrollPos.bodyScrollTop !== undefined) {
        document.body.scrollTop = scrollPos.bodyScrollTop;
        document.body.scrollLeft = scrollPos.bodyScrollLeft || 0;
      }
    });
  } catch (e) {
    console.warn("[TMDBG Config] Failed to restore scroll position", e);
  }
}

