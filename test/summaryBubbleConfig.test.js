// summaryBubbleConfig.test.js — Tests for theme/modules/summaryBubbleConfig.js
//
// The module is an IIFE that attaches globalThis.TabMailSummaryBubbleConfig.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let CONFIG;

beforeAll(() => {
  const sandbox = { globalThis: {}, console };
  const code = readFileSync(resolve(__dirname, '../theme/modules/summaryBubbleConfig.js'), 'utf8');
  runInNewContext(code, sandbox);
  CONFIG = sandbox.globalThis.TabMailSummaryBubbleConfig;
});

describe('TabMailSummaryBubbleConfig', () => {
  it('is defined after loading', () => {
    expect(CONFIG).toBeDefined();
    expect(typeof CONFIG).toBe('object');
  });

  it('has bubbleId', () => {
    expect(CONFIG.bubbleId).toBe('tabmail-message-bubbles');
  });

  it('has spacing dimensions as numbers', () => {
    expect(typeof CONFIG.marginHorizontalPx).toBe('number');
    expect(typeof CONFIG.marginTopPx).toBe('number');
    expect(typeof CONFIG.marginBottomPx).toBe('number');
    expect(typeof CONFIG.paddingHorizontalPx).toBe('number');
    expect(typeof CONFIG.paddingVerticalPx).toBe('number');
    expect(typeof CONFIG.borderRadiusPx).toBe('number');
  });

  it('has typography config', () => {
    expect(CONFIG.fontPreset).toBe('message-box');
    expect(CONFIG.fontSize).toBe('small');
  });

  it('has warning colors', () => {
    expect(CONFIG.warningBgLight).toBeDefined();
    expect(CONFIG.warningBgDark).toBeDefined();
    expect(CONFIG.warningBorder).toBe('#ffc40d');
    expect(CONFIG.warningTextLight).toBeDefined();
    expect(CONFIG.warningTextDark).toBeDefined();
  });

  it('has performance knobs', () => {
    expect(typeof CONFIG.enableResizeObserver).toBe('boolean');
    expect(typeof CONFIG.enableJsSizing).toBe('boolean');
    expect(typeof CONFIG.enableDiagnostics).toBe('boolean');
  });

  it('has ResizeObserver disabled by default', () => {
    expect(CONFIG.enableResizeObserver).toBe(false);
  });

  it('has JS sizing disabled by default', () => {
    expect(CONFIG.enableJsSizing).toBe(false);
  });

  it('has diagnostics disabled by default', () => {
    expect(CONFIG.enableDiagnostics).toBe(false);
  });
});
