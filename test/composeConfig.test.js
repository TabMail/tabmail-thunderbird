// composeConfig.test.js — Tests for compose/modules/config.js
//
// The module uses `var TabMail = TabMail || {}` pattern and sets TabMail.config.
// It's a classic script, loaded via vm.runInNewContext.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let config;

beforeAll(() => {
  const code = readFileSync(resolve(__dirname, '../compose/modules/config.js'), 'utf8');
  // Mock getComputedStyle and window.matchMedia
  const sandbox = {
    TabMail: {},
    console,
    document: {
      documentElement: {},
    },
    window: {
      matchMedia: () => ({ matches: false }),
    },
    getComputedStyle: () => ({
      getPropertyValue: () => '',
    }),
  };
  runInNewContext(code, sandbox);
  config = sandbox.TabMail.config;
});

describe('TabMail.config', () => {
  it('is defined after loading', () => {
    expect(config).toBeDefined();
    expect(typeof config).toBe('object');
  });

  it('has DELETED_NEWLINE_VISUAL_CHAR', () => {
    expect(config.DELETED_NEWLINE_VISUAL_CHAR).toBe('⏎');
  });

  it('has newlineMarker config', () => {
    expect(config.newlineMarker).toBeDefined();
    expect(typeof config.newlineMarker.NBSP_COUNT).toBe('number');
  });

  it('has composeWrap config', () => {
    expect(config.composeWrap).toBeDefined();
    expect(config.composeWrap.EDITOR_WIDTH_PERCENT).toBe(98);
    expect(config.composeWrap.EDITOR_MAX_WIDTH_PERCENT).toBe(100);
  });

  it('has autocompleteDelay config', () => {
    expect(config.autocompleteDelay).toBeDefined();
    expect(typeof config.autocompleteDelay.INITIAL_IDLE_MS).toBe('number');
    expect(typeof config.autocompleteDelay.MAX_IDLE_MS).toBe('number');
    expect(typeof config.autocompleteDelay.BACKOFF_STEP_MS).toBe('number');
  });

  it('has keybindings', () => {
    expect(config.keys).toBeDefined();
    expect(config.keys.localAccept.key).toBe('Tab');
    expect(config.keys.globalAccept.key).toBe('Tab');
    expect(config.keys.toggleDiffView.key).toBe('Escape');
    expect(config.keys.inlineEditCmd.key).toBe('k');
    expect(config.keys.inlineEditExecuteCmd.key).toBe('Enter');
  });

  it('has color configuration', () => {
    expect(config.colors).toBeDefined();
    expect(config.colors.insert).toBeDefined();
    expect(config.colors.delete).toBeDefined();
    expect(config.colors.cursorJump).toBeDefined();
  });

  it('has diff configuration', () => {
    expect(typeof config.dmpEditCost).toBe('number');
    expect(typeof config.dmpCheckLines).toBe('boolean');
    expect(typeof config.dmpUseSemanticCleanup).toBe('boolean');
    expect(typeof config.dmpUseSemanticLossless).toBe('boolean');
    expect(typeof config.dmpUseEfficiencyCleanup).toBe('boolean');
  });

  it('has inline edit configuration', () => {
    expect(config.inlineEdit).toBeDefined();
    expect(typeof config.inlineEdit.zIndex).toBe('number');
    expect(typeof config.inlineEdit.maxWidthPx).toBe('number');
    expect(typeof config.inlineEdit.fontSizeEm).toBe('number');
  });

  it('has sentence splitting configuration', () => {
    expect(config.sentences).toBeDefined();
    expect(typeof config.sentences.mergeUrls).toBe('boolean');
    expect(typeof config.sentences.urlMaxMergeParts).toBe('number');
  });

  it('has logging configuration', () => {
    expect(typeof config.LOG_LEVEL).toBe('number');
    expect(config.logCategories).toBeDefined();
  });

  it('has quote separator config', () => {
    expect(config.quoteSeparator).toBeDefined();
    expect(config.quoteSeparator.BR_COUNT_DEFAULT).toBe(2);
    expect(config.quoteSeparator.BR_COUNT_WHEN_SIGNATURE_BOUNDARY_WITH_QUOTE_AFTER).toBe(1);
  });

  it('has timing constants', () => {
    expect(typeof config.TRIGGER_THROTTLE_MS).toBe('number');
    expect(typeof config.DIFF_RESTORE_DELAY_MS).toBe('number');
    expect(typeof config.SELECTION_DEBOUNCE_MS).toBe('number');
    expect(typeof config.CHAR_DIFF_THRESHOLD).toBe('number');
    expect(typeof config.COMPOSE_EDITOR_POLL_INTERVAL_MS).toBe('number');
    expect(typeof config.COMPOSE_EDITOR_POLL_TIMEOUT_MS).toBe('number');
  });

  it('has token configuration', () => {
    expect(config.tokens).toBeDefined();
    expect(typeof config.tokens.normalizeWhitespaceForEquality).toBe('boolean');
  });
});

describe('getColor', () => {
  it('returns string value directly', () => {
    expect(config.getColor('red')).toBe('red');
  });

  it('returns light variant for object with light/dark in light mode', () => {
    // Our mock has matchMedia returning false (light mode)
    const result = config.getColor({ light: 'lightval', dark: 'darkval' });
    expect(result).toBe('lightval');
  });

  it('returns input for non-object, non-string values', () => {
    expect(config.getColor(undefined)).toBe(undefined);
    expect(config.getColor(null)).toBe(null);
  });
});
