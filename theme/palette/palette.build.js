// /theme/palette.build.js
// Builder utilities for TabMail color palette system
// Used by both MV3/content scripts and Experiment parent
// NO privileged imports — pure ES module

/**
 * Build CSS custom properties from palette data (with @media queries for dark mode)
 * @param {Object} P - Palette data object with TAG_COLORS, BASE, OPACITY, SATURATION, BRIGHTNESS, THEME
 * @returns {string} CSS with :root variables and @media queries for dark mode
 */
export function buildPaletteCSS(P) {
  const { TAG_COLORS, BASE, OPACITY, SATURATION, BRIGHTNESS, THEME, SPACING, TYPOGRAPHY } = P;
  const LIGHT = THEME.LIGHT;
  const DARK = THEME.DARK;
  const cardPaddingTopPx = SPACING.CARD_PADDING_TOP_PX;
  const cardPaddingBottomPx = SPACING.CARD_PADDING_BOTTOM_PX;
  const readStatusSizePx = SPACING.READ_STATUS_SIZE_PX;
  const cardSenderScale = TYPOGRAPHY.CARD_SENDER_SCALE;

  // Parse YELLOW hex to RGB for rgba() usage
  const yellowHex = BASE.YELLOW;
  const yR = parseInt(yellowHex.slice(1, 3), 16);
  const yG = parseInt(yellowHex.slice(3, 5), 16);
  const yB = parseInt(yellowHex.slice(5, 7), 16);

  return `
:root {
  /* TabMail Tag Colors */
  --tag-tm-reply: ${TAG_COLORS.tm_reply};
  --tag-tm-delete: ${TAG_COLORS.tm_delete};
  --tag-tm-archive: ${TAG_COLORS.tm_archive};
  --tag-tm-none: ${TAG_COLORS.tm_none};
  --tag-tm-untagged: ${TAG_COLORS.tm_untagged};

  /* TabMail Warning Colors - Light Mode (derived from BASE.YELLOW) */
  --tm-warning-bg: rgba(${yR},${yG},${yB},${OPACITY.SUBTLE_LIGHT + 0.05});
  --tm-warning-border: ${BASE.YELLOW};
  --tm-warning-text: ${BASE.TEXT_UNREAD_LIGHT};

  /* TabMail Base Colors */
  --tm-text-unread-light: ${BASE.TEXT_UNREAD_LIGHT};
  --tm-text-unread-dark:  ${BASE.TEXT_UNREAD_DARK};
  --tm-text-read-light:   ${BASE.TEXT_READ_LIGHT};
  --tm-text-read-dark:    ${BASE.TEXT_READ_DARK};
  --tm-selection-blue:    ${BASE.SELECTION_BLUE};
  --tm-hover-light:       ${BASE.HOVER_LIGHT};
  --tm-hover-dark:        ${BASE.HOVER_DARK};
  --tm-cursor-indicator:  ${BASE.CURSOR_INDICATOR};

  /* TabMail Hint Colors - Light Mode */
  --tm-hint-bg: rgba(0, 0, 0, 0.8);
  --tm-hint-text: #ffffff;
  --tm-hint-border: rgba(255, 255, 255, 0.15);
  --tm-hint-subtle-text: rgba(100, 100, 100, 0.6);
  --tm-hint-banner-text: rgba(120, 120, 120, 0.5);

  /* TabMail Opacity Constants */
  --tm-opacity-subtle-light: ${Math.round(OPACITY.SUBTLE_LIGHT * 100)}%;
  --tm-opacity-subtle-dark:  ${Math.round(OPACITY.SUBTLE_DARK * 100)}%;
  --tm-opacity-subtle-card-dark: ${Math.round(OPACITY.SUBTLE_CARD_DARK * 100)}%;
  --tm-opacity-sel-light:    ${Math.round(OPACITY.SELECTED_LIGHT * 100)}%;
  --tm-opacity-sel-dark:     ${Math.round(OPACITY.SELECTED_DARK * 100)}%;

  /* TabMail Saturation Constants */
  --tm-saturation-subtle-light: ${SATURATION.SUBTLE_LIGHT};
  --tm-saturation-subtle-dark:  ${SATURATION.SUBTLE_DARK};
  --tm-saturation-sel-light:    ${SATURATION.SELECTED_LIGHT};
  --tm-saturation-sel-dark:     ${SATURATION.SELECTED_DARK};

  /* TabMail Brightness Constants */
  --tm-brightness-subtle-light: ${BRIGHTNESS.SUBTLE_LIGHT};
  --tm-brightness-subtle-dark:  ${BRIGHTNESS.SUBTLE_DARK};
  --tm-brightness-sel-light:    ${BRIGHTNESS.SELECTED_LIGHT};
  --tm-brightness-sel-dark:     ${BRIGHTNESS.SELECTED_DARK};

  /* TabMail Diff Colors */
  --tm-insert-bg-light:    rgba(0,163,0,${OPACITY.SUBTLE_LIGHT});
  --tm-insert-text-light:  ${BASE.TEXT_READ_LIGHT};
  --tm-insert-selbg-light: rgba(0,163,0,${OPACITY.SELECTED_LIGHT});
  --tm-insert-seltext-light:${BASE.TEXT_READ_LIGHT};

  --tm-delete-bg-light:    rgba(238,17,17,${OPACITY.SUBTLE_LIGHT});
  --tm-delete-text-light:  inherit;
  --tm-delete-selbg-light: rgba(238,17,17,${OPACITY.SELECTED_LIGHT});
  --tm-delete-seltext-light: inherit;

  --tm-insert-bg-dark:     rgba(0,163,0,${OPACITY.SUBTLE_DARK});
  --tm-insert-text-dark:   ${BASE.TEXT_READ_DARK};
  --tm-insert-selbg-dark:  rgba(0,163,0,${OPACITY.SELECTED_DARK});
  --tm-insert-seltext-dark:${BASE.TEXT_READ_DARK};

  --tm-delete-bg-dark:     rgba(238,17,17,${OPACITY.SUBTLE_DARK});
  --tm-delete-text-dark:   inherit;
  --tm-delete-selbg-dark:  rgba(238,17,17,${OPACITY.SELECTED_DARK});
  --tm-delete-seltext-dark: inherit;

  /* TabMail Computed Colors */
  --tm-message-unread-color: var(--message-list-unread-color, var(--tm-text-unread-light));
  --tm-message-read-base:    var(--message-list-read-color,   var(--tm-text-read-light));
  --tm-message-read-color:   color-mix(in srgb, var(--tm-message-read-base), white 12%);
  --tm-selected-outline:     var(--selected-item-color, var(--tm-selection-blue));
  --tm-hover-bgcolor:        var(--button-hover-bgcolor, var(--tm-hover-light));

  /* TabMail Preview Pane Background */
  --tm-preview-pane-bg: ${LIGHT.PREVIEW_PANE_BG};

  /* Thunderbird Theme - Light Mode (default) */
  --in-content-page-background: ${LIGHT.PAGE_BG};
  --in-content-page-color: ${LIGHT.PAGE_COLOR};
  --in-content-box-background: ${LIGHT.BOX_BG};
  --in-content-box-background-hover: ${LIGHT.BOX_BG_HOVER};
  --in-content-button-background: ${LIGHT.BUTTON_BG};
  --in-content-button-background-hover: ${LIGHT.BUTTON_BG_HOVER};
  --in-content-button-background-active: ${LIGHT.BUTTON_BG_ACTIVE};
  --in-content-button-color: ${LIGHT.BUTTON_COLOR};
  --in-content-text-color: ${LIGHT.TEXT_COLOR};
  --in-content-accent-color: ${LIGHT.ACCENT_COLOR};
  --panel-separator-color: rgba(0,0,0,${LIGHT.SEPARATOR_OPACITY});
  --arrowpanel-background: ${LIGHT.ARROW_BG};
  --arrowpanel-color: ${LIGHT.ARROW_COLOR};
  --arrowpanel-dimmed: ${LIGHT.ARROW_DIMMED};

  /* TabMail Spacing */
  --tm-spacing-card-padding-top: ${cardPaddingTopPx}px;
  --tm-spacing-card-padding-bottom: ${cardPaddingBottomPx}px;
  /* TabMail Typography */
  --tm-card-sender-scale: ${cardSenderScale};

  /* TabMail Unread Indicator (Blue Circle) */
  --tm-read-status-size: ${readStatusSizePx}px;
  --tm-unread-indicator-color: ${BASE.SELECTION_BLUE};
}

@media (prefers-color-scheme: dark) {
  :root {
    /* TabMail Warning Colors - Dark Mode (derived from BASE.YELLOW) */
    --tm-warning-bg: rgba(${yR},${yG},${yB},${OPACITY.SELECTED_LIGHT});
    --tm-warning-border: ${BASE.YELLOW};
    --tm-warning-text: ${BASE.TEXT_UNREAD_DARK};

    /* TabMail Computed Colors - Dark Mode */
    --tm-message-unread-color: var(--message-list-unread-color, var(--tm-text-unread-dark));
    --tm-message-read-base:    var(--message-list-read-color,   var(--tm-text-read-dark));
    --tm-message-read-color:   color-mix(in srgb, var(--tm-message-read-base), black 16%);
    --tm-selected-outline:     var(--selected-item-color, var(--tm-selection-blue));
    --tm-hover-bgcolor:        var(--button-hover-bgcolor, var(--tm-hover-dark));

    /* TabMail Hint Colors - Dark Mode */
    --tm-hint-bg: rgba(50, 50, 50, 0.95);
    --tm-hint-text: #f1f2f4;
    --tm-hint-border: rgba(255, 255, 255, 0.2);
    --tm-hint-subtle-text: rgba(180, 180, 180, 0.5);
    --tm-hint-banner-text: rgba(160, 160, 160, 0.45);

    /* TabMail Preview Pane Background - Dark Mode */
    --tm-preview-pane-bg: ${DARK.PREVIEW_PANE_BG};
    /* TabMail Typography (same scale across themes) */
    --tm-card-sender-scale: ${cardSenderScale};

    /* Thunderbird Theme - Dark Mode */
    --in-content-page-background: ${DARK.PAGE_BG};
    --in-content-page-color: ${DARK.PAGE_COLOR};
    --in-content-box-background: ${DARK.BOX_BG};
    --in-content-box-background-hover: ${DARK.BOX_BG_HOVER};
    --in-content-button-background: ${DARK.BUTTON_BG};
    --in-content-button-background-hover: ${DARK.BUTTON_BG_HOVER};
    --in-content-button-background-active: ${DARK.BUTTON_BG_ACTIVE};
    --in-content-button-color: ${DARK.BUTTON_COLOR};
    --in-content-text-color: ${DARK.TEXT_COLOR};
    --in-content-accent-color: ${DARK.ACCENT_COLOR};
    --panel-separator-color: rgba(249,249,250,${DARK.SEPARATOR_OPACITY});
    --arrowpanel-background: ${DARK.ARROW_BG};
    --arrowpanel-color: ${DARK.ARROW_COLOR};
    --arrowpanel-dimmed: ${DARK.ARROW_DIMMED};
  }
}
`.trim();
}

/**
 * Derive diff colors for JS-side usage (when DOM is not available)
 * @param {Object} P - Palette data object
 * @param {boolean} isDark - Whether dark mode is active
 * @returns {Object} Diff colors object
 */
export function deriveDiffColors(P, isDark) {
  const { BASE, OPACITY } = P;
  return {
    insert: {
      bg:      isDark ? `rgba(0,163,0,${OPACITY.SUBTLE_DARK})`   : `rgba(0,163,0,${OPACITY.SUBTLE_LIGHT})`,
      selBg:   isDark ? `rgba(0,163,0,${OPACITY.SELECTED_DARK})` : `rgba(0,163,0,${OPACITY.SELECTED_LIGHT})`,
      text:    isDark ? BASE.TEXT_READ_DARK : BASE.TEXT_READ_LIGHT,
      selText: isDark ? BASE.TEXT_READ_DARK : BASE.TEXT_READ_LIGHT,
    },
    delete: {
      bg:      isDark ? `rgba(238,17,17,${OPACITY.SUBTLE_DARK})`   : `rgba(238,17,17,${OPACITY.SUBTLE_LIGHT})`,
      selBg:   isDark ? `rgba(238,17,17,${OPACITY.SELECTED_DARK})` : `rgba(238,17,17,${OPACITY.SELECTED_LIGHT})`,
      text:    "inherit",
      selText: "inherit",
    },
    cursor: BASE.CURSOR_INDICATOR,
  };
}

// Dual export: support both ES6 modules and sandbox eval (for Experiment fallback)
// When loaded via Cu.evalInSandbox, 'exports' will be available
try {
  if (typeof exports !== 'undefined') {
    exports.buildPaletteCSS = buildPaletteCSS;
    exports.deriveDiffColors = deriveDiffColors;
  }
} catch (e) {
  // Ignore - ES6 context where 'exports' doesn't exist
}
