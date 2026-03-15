// threadBubbleConfig.test.js — Tests for theme/modules/threadBubbleConfig.js
//
// The module is an IIFE that attaches globalThis.TabMailThreadBubbleConfig.

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let CONFIG;

beforeAll(() => {
  const sandbox = { globalThis: {}, console };
  const code = readFileSync(resolve(__dirname, '../theme/modules/threadBubbleConfig.js'), 'utf8');
  runInNewContext(code, sandbox);
  CONFIG = sandbox.globalThis.TabMailThreadBubbleConfig;
});

describe('TabMailThreadBubbleConfig', () => {
  it('is defined after loading', () => {
    expect(CONFIG).toBeDefined();
    expect(typeof CONFIG).toBe('object');
  });

  it('has THREAD_BUBBLE_UI config', () => {
    expect(CONFIG.THREAD_BUBBLE_UI).toBeDefined();
    expect(typeof CONFIG.THREAD_BUBBLE_UI).toBe('object');
  });

  it('has THREAD_CLASSES config', () => {
    expect(CONFIG.THREAD_CLASSES).toBeDefined();
    expect(typeof CONFIG.THREAD_CLASSES).toBe('object');
  });
});

describe('THREAD_BUBBLE_UI', () => {
  it('has layout dimensions as numbers', () => {
    const ui = CONFIG.THREAD_BUBBLE_UI;
    expect(typeof ui.unreadBorderWidthPx).toBe('number');
    expect(typeof ui.actionGapPx).toBe('number');
    expect(typeof ui.actionPaddingYPx).toBe('number');
    expect(typeof ui.actionPaddingXPx).toBe('number');
    expect(typeof ui.actionBorderRadiusPx).toBe('number');
  });

  it('has typography config', () => {
    const ui = CONFIG.THREAD_BUBBLE_UI;
    expect(ui.fontPreset).toBe('message-box');
    expect(ui.fontSizeBase).toBe('medium');
    expect(ui.fontSizeSubject).toBe('medium');
    expect(ui.fontSizeFrom).toBe('medium');
    expect(ui.fontSizeDate).toBe('small');
    expect(ui.fontSizeBody).toBe('medium');
    expect(ui.fontSizeMeta).toBe('small');
    expect(ui.fontSizePreview).toBe('small');
    expect(ui.fontSizeAttachmentIndicator).toBe('small');
    expect(ui.fontSizeAttachmentsHeader).toBe('small');
    expect(ui.fontSizeAction).toBe('small');
  });
});

describe('THREAD_CLASSES', () => {
  it('has container class', () => {
    expect(CONFIG.THREAD_CLASSES.container).toBe('tm-thread-container');
  });

  it('has bubble class', () => {
    expect(CONFIG.THREAD_CLASSES.bubble).toBe('tm-thread-bubble');
  });

  it('has all expected class names', () => {
    const classes = CONFIG.THREAD_CLASSES;
    const expectedKeys = [
      'container', 'bubble', 'headerRight', 'actions', 'actionBtn',
      'subject', 'from', 'date', 'meta', 'preview', 'bodyFull',
      'attachmentIndicator', 'attachmentsSection', 'attachmentsHeader',
      'attachmentsList', 'attachmentItem', 'collapsed', 'expanded',
      'unread', 'read',
    ];
    for (const key of expectedKeys) {
      expect(typeof classes[key]).toBe('string');
    }
  });

  it('all class names start with tm-thread-', () => {
    for (const [key, value] of Object.entries(CONFIG.THREAD_CLASSES)) {
      expect(value).toMatch(/^tm-thread-/);
    }
  });
});
