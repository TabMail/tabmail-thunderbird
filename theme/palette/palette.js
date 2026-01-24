/**
 * TabMail Color Palette - SINGLE SOURCE OF TRUTH (JSON-based)
 * 
 * All color values are defined in palette.data.json
 * This module provides:
 * 1. Async loading from JSON (works in both MV3 and Experiment contexts)
 * 2. JS constants for logic/calculations
 * 3. CSS custom properties via injection
 * 4. Backward compatibility with old API
 * 
 * This module can be used in:
 * - ES6 modules (background scripts, content scripts) - use browser.runtime.getURL
 * - Experiment parent - use context.extension.getURL
 * 
 * ⚠️ IMPORTANT: palette.data.json is the ONLY place where hex color values are defined!
 */

import { buildPaletteCSS as buildPaletteCSSFromData, deriveDiffColors } from './palette.build.js';

// ============================================================================
// PALETTE DATA LOADER
// ============================================================================

let cachedPaletteData = null;

/**
 * Load palette data from JSON
 * Works in both MV3/content scripts (browser.runtime.getURL) and 
 * Experiment parent (context.extension.getURL - pass as parameter)
 * @param {string|Function} [urlOrGetter] - URL or getter function; defaults to browser.runtime.getURL
 * @returns {Promise<Object>} Palette data object
 */
export async function loadPaletteData(urlOrGetter) {
  if (cachedPaletteData) {
    return cachedPaletteData;
  }

  let url;
  if (typeof urlOrGetter === 'function') {
    url = urlOrGetter('theme/palette/palette.data.json');
  } else if (typeof urlOrGetter === 'string') {
    url = urlOrGetter;
  } else {
    // Default: assume MV3/content script context with browser API
    if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.getURL) {
      url = browser.runtime.getURL('theme/palette/palette.data.json');
    } else {
      throw new Error('loadPaletteData: No URL or getter provided and browser.runtime.getURL not available');
    }
  }

  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(`Failed to load palette.data.json: ${resp.status}`);
  }

  cachedPaletteData = await resp.json();
  return cachedPaletteData;
}

// ============================================================================
// CONVENIENCE EXPORTS (cached after first load)
// ============================================================================

let _BASE, _TAG_COLORS, _OPACITY, _DIFF, _THEME;

/**
 * Get BASE constants (lazy load from JSON)
 */
export async function getBASE() {
  if (!_BASE) {
    const P = await loadPaletteData();
    _BASE = P.BASE;
  }
  return _BASE;
}

/**
 * Get TAG_COLORS (lazy load from JSON)
 */
export async function getTAG_COLORS() {
  if (!_TAG_COLORS) {
    const P = await loadPaletteData();
    _TAG_COLORS = P.TAG_COLORS;
  }
  return _TAG_COLORS;
}

/**
 * Get OPACITY constants (lazy load from JSON)
 */
export async function getOPACITY() {
  if (!_OPACITY) {
    const P = await loadPaletteData();
    _OPACITY = P.OPACITY;
  }
  return _OPACITY;
}

/**
 * Get THEME colors (lazy load from JSON)
 */
export async function getTHEME() {
  if (!_THEME) {
    const P = await loadPaletteData();
    _THEME = P.THEME;
  }
  return _THEME;
}

/**
 * Get DIFF colors (lazy load from JSON and derive)
 */
export async function getDIFF(isDark) {
  if (!_DIFF) {
    const P = await loadPaletteData();
    const dark = isDark !== undefined ? isDark : (typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    _DIFF = deriveDiffColors(P, dark);
  }
  return _DIFF;
}

// ============================================================================
// CSS INJECTION (async)
// ============================================================================

/**
 * Inject palette CSS into a document
 * @param {Document} [doc] - Target document (defaults to current document)
 * @param {string|Function} [urlOrGetter] - URL or getter function for JSON
 * @returns {Promise<HTMLStyleElement>} The injected style element
 */
export async function injectPaletteIntoDocument(doc = document, urlOrGetter) {
  // Check if already injected
  const existing = doc.querySelector('style[data-tabmail="palette"]');
  if (existing) {
    return existing;
  }

  const P = await loadPaletteData(urlOrGetter);
  const css = buildPaletteCSSFromData(P);

  const style = doc.createElement('style');
  style.setAttribute('data-tabmail', 'palette');
  style.textContent = css;
  doc.head.appendChild(style);
  
  return style;
}

/**
 * Build CSS string from palette data (async wrapper)
 * @param {string|Function} [urlOrGetter] - URL or getter function for JSON
 * @returns {Promise<string>} CSS string
 */
export async function buildPaletteCSS(urlOrGetter) {
  const P = await loadPaletteData(urlOrGetter);
  return buildPaletteCSSFromData(P);
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Check if dark mode is active
 * @returns {boolean}
 */
export function isDarkMode() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch (e) {
    return false;
  }
}

/**
 * Get theme-appropriate color from light/dark pair
 * @param {string} lightColor - Color for light mode
 * @param {string} darkColor - Color for dark mode
 * @returns {string}
 */
export function getThemedColor(lightColor, darkColor) {
  return isDarkMode() ? darkColor : lightColor;
}

/**
 * Get color by semantic name (async - loads from JSON)
 * @param {string} name - Color name (e.g., "insert.bg", "delete.selBg")
 * @param {boolean} [dark] - Force dark mode (defaults to current theme)
 * @returns {Promise<string>}
 */
export async function getThemeColor(name, dark) {
  const P = await loadPaletteData();
  const useDark = dark !== undefined ? dark : isDarkMode();
  const diffColors = deriveDiffColors(P, useDark);
  
  const map = {
    'insert.bg':     diffColors.insert.bg,
    'insert.selBg':  diffColors.insert.selBg,
    'insert.text':   diffColors.insert.text,
    'insert.selText':diffColors.insert.selText,
    'delete.bg':     diffColors.delete.bg,
    'delete.selBg':  diffColors.delete.selBg,
    'delete.text':   diffColors.delete.text,
    'delete.selText':diffColors.delete.selText,
    'cursor':        P.BASE.CURSOR_INDICATOR,
    'text.read':     useDark ? P.BASE.TEXT_READ_DARK : P.BASE.TEXT_READ_LIGHT,
    'text.unread':   useDark ? P.BASE.TEXT_UNREAD_DARK : P.BASE.TEXT_UNREAD_LIGHT,
  };
  
  return map[name] || '';
}

/**
 * Get color value (backward compatibility)
 * @param {string|Object} colorConfig - Color string or {light, dark} object
 * @returns {string}
 */
export function getColor(colorConfig) {
  if (typeof colorConfig === 'string') {
    return colorConfig;
  }
  if (colorConfig && typeof colorConfig === 'object') {
    const dark = isDarkMode();
    return dark ? (colorConfig.dark || colorConfig.light) : (colorConfig.light || colorConfig.dark);
  }
  return colorConfig;
}

/**
 * Convert hex to rgba
 * @param {string} hex - Hex color (#rrggbb)
 * @param {number} opacity - Opacity 0-1
 * @returns {string}
 */
export function hexToRgba(hex, opacity) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r}, ${g}, ${b}, ${opacity})`;
}

/**
 * Get tag color with opacity (async)
 * @param {string} tagName - 'reply', 'delete', 'archive', 'none'
 * @param {number} opacity - Opacity 0-1
 * @returns {Promise<string>}
 */
export async function getTagColor(tagName, opacity = 1.0) {
  const TAG_COLORS = await getTAG_COLORS();
  const colorMap = {
    reply: TAG_COLORS.tm_reply,
    delete: TAG_COLORS.tm_delete,
    archive: TAG_COLORS.tm_archive,
    none: TAG_COLORS.tm_none,
  };
  
  const color = colorMap[tagName];
  if (!color) return 'transparent';
  return hexToRgba(color, opacity);
}

/**
 * Get tinted background for a tag (async)
 * @param {string} tagName - 'reply', 'delete', 'archive', 'none'
 * @param {boolean} selected - Whether selected
 * @returns {Promise<string>}
 */
export async function getTagTint(tagName, selected = false) {
  const [TAG_COLORS, OPACITY] = await Promise.all([getTAG_COLORS(), getOPACITY()]);
  
  const colorMap = {
    reply: TAG_COLORS.tm_reply,
    delete: TAG_COLORS.tm_delete,
    archive: TAG_COLORS.tm_archive,
    none: TAG_COLORS.tm_none,
  };
  
  const baseColor = colorMap[tagName];
  if (!baseColor) return 'transparent';
  
  const opacity = selected
    ? (isDarkMode() ? OPACITY.SELECTED_DARK : OPACITY.SELECTED_LIGHT)
    : (isDarkMode() ? OPACITY.SUBTLE_DARK : OPACITY.SUBTLE_LIGHT);
  
  return hexToRgba(baseColor, opacity);
}

/**
 * Listen for theme changes
 * @param {Function} callback - Called with isDark boolean
 * @returns {Function} Cleanup function
 */
export function onThemeChange(callback) {
  if (!window.matchMedia) return () => {};
  
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const handler = (e) => callback(e.matches);
  
  try {
    mediaQuery.addEventListener('change', handler);
    return () => mediaQuery.removeEventListener('change', handler);
  } catch (e) {
    mediaQuery.addListener(handler);
    return () => mediaQuery.removeListener(handler);
  }
}

// ============================================================================
// SYNCHRONOUS EXPORTS (for immediate use after preload)
// ============================================================================

// These are populated after loadPaletteData() is called
// Use the async getters above for guaranteed access
export { _BASE as BASE, _DIFF as DIFF, _OPACITY as OPACITY, _TAG_COLORS as TAG_COLORS, _THEME as THEME };

// Re-export builder functions for convenience
  export { buildPaletteCSSFromData, deriveDiffColors };

