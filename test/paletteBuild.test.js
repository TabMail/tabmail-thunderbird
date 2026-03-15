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
