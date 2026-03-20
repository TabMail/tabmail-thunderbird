// paletteBuild.test.js — Tests for theme/palette/palette.build.js
//
// Tests buildPaletteCSS and deriveDiffColors pure functions.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const { buildPaletteCSS, deriveDiffColors } = await import('../theme/palette/palette.build.js');
const paletteData = JSON.parse(
  readFileSync(resolve(__dirname, '../theme/palette/palette.data.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// buildPaletteCSS
// ---------------------------------------------------------------------------
describe('buildPaletteCSS', () => {
  it('returns a non-empty string', () => {
    const css = buildPaletteCSS(paletteData);
    expect(typeof css).toBe('string');
    expect(css.length).toBeGreaterThan(100);
  });

  it('contains :root selector', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain(':root');
  });

  it('contains tag color variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tag-tm-reply');
    expect(css).toContain('--tag-tm-delete');
    expect(css).toContain('--tag-tm-archive');
    expect(css).toContain('--tag-tm-none');
    expect(css).toContain('--tag-tm-untagged');
  });

  it('contains tag color values from palette data', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain(paletteData.TAG_COLORS.tm_reply);
    expect(css).toContain(paletteData.TAG_COLORS.tm_delete);
    expect(css).toContain(paletteData.TAG_COLORS.tm_archive);
  });

  it('contains dark mode media query', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('@media (prefers-color-scheme: dark)');
  });

  it('contains base color variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-text-unread-light');
    expect(css).toContain('--tm-text-unread-dark');
    expect(css).toContain('--tm-selection-blue');
  });

  it('contains diff color variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-insert-bg-light');
    expect(css).toContain('--tm-delete-bg-light');
    expect(css).toContain('--tm-insert-bg-dark');
    expect(css).toContain('--tm-delete-bg-dark');
  });

  it('contains spacing variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-spacing-card-padding-top');
    expect(css).toContain('--tm-spacing-card-padding-bottom');
  });

  it('contains typography variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-card-sender-scale');
  });

  it('contains opacity variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-opacity-subtle-light');
    expect(css).toContain('--tm-opacity-subtle-dark');
  });

  it('contains danger color variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-danger-text');
  });

  it('contains warning color variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-warning-bg');
    expect(css).toContain('--tm-warning-border');
    expect(css).toContain('--tm-warning-text');
  });

  it('contains preview pane background variable', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-preview-pane-bg');
  });

  it('contains hint color variables', () => {
    const css = buildPaletteCSS(paletteData);
    expect(css).toContain('--tm-hint-bg');
    expect(css).toContain('--tm-hint-text');
    expect(css).toContain('--tm-hint-border');
  });

  it('converts opacity values to percentages for CSS custom properties', () => {
    const css = buildPaletteCSS(paletteData);
    const { OPACITY } = paletteData;
    // Opacity values are converted to percentage strings (e.g., 0.10 -> "10%")
    expect(css).toContain(`${Math.round(OPACITY.SUBTLE_LIGHT * 100)}%`);
    expect(css).toContain(`${Math.round(OPACITY.SUBTLE_DARK * 100)}%`);
    expect(css).toContain(`${Math.round(OPACITY.SUBTLE_CARD_DARK * 100)}%`);
    expect(css).toContain(`${Math.round(OPACITY.SELECTED_LIGHT * 100)}%`);
    expect(css).toContain(`${Math.round(OPACITY.SELECTED_DARK * 100)}%`);
  });

  it('uses rgba() format for warning colors derived from BASE.YELLOW', () => {
    const css = buildPaletteCSS(paletteData);
    const yellowHex = paletteData.BASE.YELLOW;
    const yR = parseInt(yellowHex.slice(1, 3), 16);
    const yG = parseInt(yellowHex.slice(3, 5), 16);
    const yB = parseInt(yellowHex.slice(5, 7), 16);
    // Warning bg uses rgba with yellow RGB components
    expect(css).toContain(`rgba(${yR},${yG},${yB},`);
  });

  it('handles the full palette.data.json correctly (integration test)', () => {
    const css = buildPaletteCSS(paletteData);
    // Light theme values
    expect(css).toContain(paletteData.THEME.LIGHT.PAGE_BG);
    expect(css).toContain(paletteData.THEME.LIGHT.ACCENT_COLOR);
    expect(css).toContain(paletteData.THEME.LIGHT.PREVIEW_PANE_BG);

    // Dark theme values
    expect(css).toContain(paletteData.THEME.DARK.PAGE_BG);
    expect(css).toContain(paletteData.THEME.DARK.ACCENT_COLOR);
    expect(css).toContain(paletteData.THEME.DARK.PREVIEW_PANE_BG);

    // Base colors
    expect(css).toContain(paletteData.BASE.RED);
    expect(css).toContain(paletteData.BASE.SELECTION_BLUE);
    expect(css).toContain(paletteData.BASE.CURSOR_INDICATOR);

    // Spacing values rendered as px
    expect(css).toContain(`${paletteData.SPACING.CARD_PADDING_TOP_PX}px`);
    expect(css).toContain(`${paletteData.SPACING.CARD_PADDING_BOTTOM_PX}px`);
    expect(css).toContain(`${paletteData.SPACING.READ_STATUS_SIZE_PX}px`);

    // Typography scale
    expect(css).toContain(`${paletteData.TYPOGRAPHY.CARD_SENDER_SCALE}`);

    // Saturation and brightness values
    expect(css).toContain(`${paletteData.SATURATION.SUBTLE_LIGHT}`);
    expect(css).toContain(`${paletteData.SATURATION.SELECTED_LIGHT}`);
    expect(css).toContain(`${paletteData.BRIGHTNESS.SUBTLE_LIGHT}`);
    expect(css).toContain(`${paletteData.BRIGHTNESS.SELECTED_LIGHT}`);
  });
});

// ---------------------------------------------------------------------------
// deriveDiffColors
// ---------------------------------------------------------------------------
describe('deriveDiffColors', () => {
  it('returns diff colors for light mode', () => {
    const colors = deriveDiffColors(paletteData, false);
    expect(colors.insert).toBeDefined();
    expect(colors.delete).toBeDefined();
    expect(colors.cursor).toBe(paletteData.BASE.CURSOR_INDICATOR);
  });

  it('returns diff colors for dark mode', () => {
    const colors = deriveDiffColors(paletteData, true);
    expect(colors.insert).toBeDefined();
    expect(colors.delete).toBeDefined();
  });

  it('insert colors differ between light and dark mode', () => {
    const light = deriveDiffColors(paletteData, false);
    const dark = deriveDiffColors(paletteData, true);
    expect(light.insert.bg).not.toBe(dark.insert.bg);
    expect(light.insert.text).not.toBe(dark.insert.text);
  });

  it('delete text is always "inherit"', () => {
    const light = deriveDiffColors(paletteData, false);
    const dark = deriveDiffColors(paletteData, true);
    expect(light.delete.text).toBe('inherit');
    expect(dark.delete.text).toBe('inherit');
    expect(light.delete.selText).toBe('inherit');
    expect(dark.delete.selText).toBe('inherit');
  });

  it('insert colors contain rgba values', () => {
    const colors = deriveDiffColors(paletteData, false);
    expect(colors.insert.bg).toMatch(/^rgba\(/);
    expect(colors.insert.selBg).toMatch(/^rgba\(/);
  });

  it('delete colors contain rgba values', () => {
    const colors = deriveDiffColors(paletteData, false);
    expect(colors.delete.bg).toMatch(/^rgba\(/);
    expect(colors.delete.selBg).toMatch(/^rgba\(/);
  });

  it('cursor is the CURSOR_INDICATOR value', () => {
    const colors = deriveDiffColors(paletteData, false);
    expect(colors.cursor).toBe('#0078d4');
  });
});

// ---------------------------------------------------------------------------
// Pure functions from palette.js: hexToRgba, getColor, isDarkMode
// ---------------------------------------------------------------------------

// hexToRgba is pure — import directly
const { hexToRgba, getColor, isDarkMode } = await import('../theme/palette/palette.js');

describe('hexToRgba', () => {
  it('converts a 6-char hex to rgba with opacity 1', () => {
    expect(hexToRgba('#ff0000', 1)).toBe('rgba(255, 0, 0, 1)');
  });

  it('converts a 6-char hex to rgba with opacity 0', () => {
    expect(hexToRgba('#00ff00', 0)).toBe('rgba(0, 255, 0, 0)');
  });

  it('converts a 6-char hex to rgba with fractional opacity', () => {
    expect(hexToRgba('#0000ff', 0.5)).toBe('rgba(0, 0, 255, 0.5)');
  });

  it('handles mixed hex values correctly', () => {
    expect(hexToRgba('#1a2b3c', 0.75)).toBe('rgba(26, 43, 60, 0.75)');
  });

  it('handles white (#ffffff)', () => {
    expect(hexToRgba('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  it('handles black (#000000)', () => {
    expect(hexToRgba('#000000', 0.5)).toBe('rgba(0, 0, 0, 0.5)');
  });

  it('handles uppercase hex letters', () => {
    expect(hexToRgba('#AABBCC', 1)).toBe('rgba(170, 187, 204, 1)');
  });
});

describe('getColor', () => {
  it('returns the string directly when given a string', () => {
    expect(getColor('#ff0000')).toBe('#ff0000');
    expect(getColor('red')).toBe('red');
  });

  it('returns light color when isDarkMode is false', () => {
    // Mock window.matchMedia for light mode
    const origWindow = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    expect(getColor({ light: '#aaa', dark: '#bbb' })).toBe('#aaa');
    globalThis.window = origWindow;
  });

  it('returns dark color when isDarkMode is true', () => {
    const origWindow = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: true }) };
    expect(getColor({ light: '#aaa', dark: '#bbb' })).toBe('#bbb');
    globalThis.window = origWindow;
  });

  it('falls back to light when dark is missing in dark mode', () => {
    const origWindow = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: true }) };
    expect(getColor({ light: '#aaa' })).toBe('#aaa');
    globalThis.window = origWindow;
  });

  it('falls back to dark when light is missing in light mode', () => {
    const origWindow = globalThis.window;
    globalThis.window = { matchMedia: () => ({ matches: false }) };
    expect(getColor({ dark: '#bbb' })).toBe('#bbb');
    globalThis.window = origWindow;
  });

  it('returns null/undefined as-is for non-string non-object', () => {
    expect(getColor(null)).toBe(null);
    expect(getColor(undefined)).toBe(undefined);
  });
});

describe('isDarkMode', () => {
  it('returns true when matchMedia matches dark scheme', () => {
    const origWindow = globalThis.window;
    globalThis.window = {
      matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: dark)' }),
    };
    expect(isDarkMode()).toBe(true);
    globalThis.window = origWindow;
  });

  it('returns false when matchMedia does not match dark scheme', () => {
    const origWindow = globalThis.window;
    globalThis.window = {
      matchMedia: () => ({ matches: false }),
    };
    expect(isDarkMode()).toBe(false);
    globalThis.window = origWindow;
  });

  it('returns falsy when window.matchMedia is not available', () => {
    const origWindow = globalThis.window;
    globalThis.window = {};
    expect(isDarkMode()).toBeFalsy();
    globalThis.window = origWindow;
  });

  it('returns false when window is not defined', () => {
    const origWindow = globalThis.window;
    delete globalThis.window;
    expect(isDarkMode()).toBe(false);
    globalThis.window = origWindow;
  });
});
