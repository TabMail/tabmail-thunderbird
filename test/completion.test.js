// completion.test.js — Tests for welcome/modules/completion.js

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { createCompletion } = await import('../welcome/modules/completion.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('createCompletion', () => {
  it('returns object with finishWizard function', () => {
    const result = createCompletion({
      saveStepSettings: vi.fn(),
      getCurrentStep: vi.fn(),
    });
    expect(result).toBeDefined();
    expect(typeof result.finishWizard).toBe('function');
  });

  it('finishWizard saves step settings and closes window', async () => {
    const saveStepSettings = vi.fn(async () => {});
    const getCurrentStep = vi.fn(() => 3);
    const closeSpy = vi.fn();

    // Mock window.close
    globalThis.window = { close: closeSpy };

    const { finishWizard } = createCompletion({ saveStepSettings, getCurrentStep });
    await finishWizard();

    expect(getCurrentStep).toHaveBeenCalled();
    expect(saveStepSettings).toHaveBeenCalledWith(3);
    expect(closeSpy).toHaveBeenCalled();
  });

  it('finishWizard handles errors gracefully', async () => {
    const saveStepSettings = vi.fn(async () => { throw new Error('fail'); });
    const getCurrentStep = vi.fn(() => 1);

    globalThis.window = { close: vi.fn() };

    const { finishWizard } = createCompletion({ saveStepSettings, getCurrentStep });
    // Should not throw
    await finishWizard();
  });
});
