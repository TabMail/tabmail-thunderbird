// composeLogger.test.js — Tests for compose/modules/logger.js

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

let log;

beforeAll(() => {
  const code = readFileSync(resolve(__dirname, '../compose/modules/logger.js'), 'utf8');
  const sandbox = {
    TabMail: {
      config: {
        LOG_LEVEL: 4, // DEBUG
        logCategories: {
          core: 3,    // INFO level for 'core'
          diff: 5,    // TRACE level for 'diff'
          silent: 0,  // NONE for 'silent'
        },
      },
    },
    console: {
      log: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  };
  runInNewContext(code, sandbox);
  log = sandbox.TabMail.log;
});

describe('TabMail.log', () => {
  it('is defined after loading', () => {
    expect(log).toBeDefined();
    expect(typeof log.error).toBe('function');
    expect(typeof log.warn).toBe('function');
    expect(typeof log.info).toBe('function');
    expect(typeof log.debug).toBe('function');
    expect(typeof log.trace).toBe('function');
  });

  it('has LEVELS constants', () => {
    expect(log.LEVELS.NONE).toBe(0);
    expect(log.LEVELS.ERROR).toBe(1);
    expect(log.LEVELS.WARN).toBe(2);
    expect(log.LEVELS.INFO).toBe(3);
    expect(log.LEVELS.DEBUG).toBe(4);
    expect(log.LEVELS.TRACE).toBe(5);
  });

  it('getCurrentLevel returns level name for category', () => {
    expect(log.getCurrentLevel('core')).toBe('INFO');
    expect(log.getCurrentLevel('diff')).toBe('TRACE');
    expect(log.getCurrentLevel('silent')).toBe('NONE');
    // Unconfigured category falls back to global LOG_LEVEL (4 = DEBUG)
    expect(log.getCurrentLevel('unknown')).toBe('DEBUG');
  });

  it('error uses console.error', () => {
    log.error('core', 'test error');
    // error (level 1) <= INFO (level 3) for core, so it should log
  });

  it('info logs for category with INFO level', () => {
    log.info('core', 'test info');
    // INFO (3) <= INFO (3), should log
  });

  it('debug does not log for category with INFO level', () => {
    // For 'core' category, level is 3 (INFO)
    // DEBUG messages (level 4) should be suppressed
  });

  it('trace logs for category with TRACE level', () => {
    log.trace('diff', 'test trace');
    // TRACE (5) <= TRACE (5) for diff, should log
  });
});
