// palette.test.js — Tests for theme/palette/palette.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock fetch to return palette data
const mockPaletteData = {
  BASE: {
    CURSOR_INDICATOR: '#FF6600',
    TEXT_READ_LIGHT: '#666666',
    TEXT_READ_DARK: '#999999',
    TEXT_UNREAD_LIGHT: '#000000',
    TEXT_UNREAD_DARK: '#FFFFFF',
  },
  TAG_COLORS: {
    tm_reply: '#0066CC',
    tm_delete: '#CC0000',
    tm_archive: '#00CC00',
    tm_none: '#808080',
  },
  OPACITY: {
    SUBTLE_LIGHT: 0.1,
    SUBTLE_DARK: 0.15,
    SELECTED_LIGHT: 0.2,
    SELECTED_DARK: 0.25,
  },
  THEME: {
    light: { bg: '#FFFFFF' },
    dark: { bg: '#1E1E1E' },
  },
  DIFF: {
    LIGHT: {
      INSERT_BG: '#E6FFE6',
      INSERT_TEXT: '#006600',
      DELETE_BG: '#FFE6E6',
      DELETE_TEXT: '#660000',
    },
    DARK: {
      INSERT_BG: '#1A3A1A',
      INSERT_TEXT: '#66CC66',
      DELETE_BG: '#3A1A1A',
      DELETE_TEXT: '#CC6666',
    },
  },
};

globalThis.fetch = vi.fn(async () => ({
  ok: true,
  json: async () => mockPaletteData,
}));

globalThis.browser = {
  runtime: {
    getURL: vi.fn((path) => `moz-extension://fake/${path}`),
  },
};

globalThis.window = {
  matchMedia: vi.fn(() => ({ matches: false })),
};

const mod = await import('../theme/palette/palette.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

describe('hexToRgba', () => {
  it('converts hex to rgba', () => {
    expect(mod.hexToRgba('#FF0000', 1)).toBe('rgba(255, 0, 0, 1)');
    expect(mod.hexToRgba('#00FF00', 0.5)).toBe('rgba(0, 255, 0, 0.5)');
    expect(mod.hexToRgba('#0000FF', 0)).toBe('rgba(0, 0, 255, 0)');
  });
});

describe('getColor', () => {
  it('returns string directly', () => {
    expect(mod.getColor('#FF0000')).toBe('#FF0000');
  });

  it('returns light color in light mode', () => {
    window.matchMedia.mockReturnValue({ matches: false });
    expect(mod.getColor({ light: 'lightval', dark: 'darkval' })).toBe('lightval');
  });

  it('returns dark color in dark mode', () => {
    window.matchMedia.mockReturnValue({ matches: true });
    expect(mod.getColor({ light: 'lightval', dark: 'darkval' })).toBe('darkval');
  });

  it('returns non-object/non-string values as-is', () => {
    expect(mod.getColor(null)).toBe(null);
    expect(mod.getColor(undefined)).toBe(undefined);
  });
});

describe('isDarkMode', () => {
  it('returns false in light mode', () => {
    window.matchMedia.mockReturnValue({ matches: false });
    expect(mod.isDarkMode()).toBe(false);
  });

  it('returns true in dark mode', () => {
    window.matchMedia.mockReturnValue({ matches: true });
    expect(mod.isDarkMode()).toBe(true);
  });
});

describe('getThemedColor', () => {
  it('returns light color in light mode', () => {
    window.matchMedia.mockReturnValue({ matches: false });
    expect(mod.getThemedColor('light', 'dark')).toBe('light');
  });

  it('returns dark color in dark mode', () => {
    window.matchMedia.mockReturnValue({ matches: true });
    expect(mod.getThemedColor('light', 'dark')).toBe('dark');
  });
});

describe('getBASE', () => {
  it('returns BASE constants', async () => {
    const base = await mod.getBASE();
    expect(base.CURSOR_INDICATOR).toBe('#FF6600');
  });
});

describe('getTAG_COLORS', () => {
  it('returns TAG_COLORS', async () => {
    const colors = await mod.getTAG_COLORS();
    expect(colors.tm_reply).toBe('#0066CC');
    expect(colors.tm_delete).toBe('#CC0000');
  });
});

describe('getTagColor', () => {
  it('returns rgba for known tag', async () => {
    const color = await mod.getTagColor('reply', 0.5);
    expect(color).toContain('rgba');
    expect(color).toContain('0.5');
  });

  it('returns transparent for unknown tag', async () => {
    const color = await mod.getTagColor('unknown');
    expect(color).toBe('transparent');
  });
});

describe('onThemeChange', () => {
  it('returns cleanup function', () => {
    window.matchMedia.mockReturnValue({
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    const cleanup = mod.onThemeChange(vi.fn());
    expect(typeof cleanup).toBe('function');
  });
});
