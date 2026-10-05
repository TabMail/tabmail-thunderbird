import { describe, expect, it, vi } from 'vitest';

// config.js registers a storage listener at import time.
vi.hoisted(() => {
  globalThis.browser = { storage: { onChanged: { addListener: () => {} } } };
});

import { readActionConfig, resolveActionConfig } from '../agent/modules/actionCompactConfig.js';
import { SETTINGS } from '../agent/modules/config.js';

const EPOCH_ZERO = '1970-01-01T00:00:00.000Z';
const editedTs = () => new Date(Date.now() - 86400000).toISOString();
const DEFAULTS = { compact_threshold: 200, compact_threshold_chars: 32000 };

describe('actionCompactConfig', () => {
  it('pins the shared defaults, range and legacy defaults (backend actionRuleBudget.ts, iOS PromptStore)', () => {
    expect(SETTINGS.actionCompaction).toEqual({
      defaultRules: 200, minRules: 100, maxRules: 500, stepRules: 10,
      defaultChars: 32000, minChars: 16000, maxChars: 80000, stepChars: 1000,
      legacyDefaultRules: 100, legacyDefaultChars: 16000,
    });
  });

  it('nothing stored resolves to the defaults', () => {
    expect(resolveActionConfig(undefined, undefined)).toEqual(DEFAULTS);
    expect(resolveActionConfig({}, EPOCH_ZERO)).toEqual(DEFAULTS);
  });

  it('never-edited legacy defaults move to the current defaults, per field', () => {
    expect(resolveActionConfig({ compact_threshold: 100, compact_threshold_chars: 16000 }, undefined)).toEqual(DEFAULTS);
    expect(resolveActionConfig({ compact_threshold: 100, compact_threshold_chars: 16000 }, EPOCH_ZERO)).toEqual(DEFAULTS);
    expect(resolveActionConfig({ compact_threshold: 300, compact_threshold_chars: 16000 }, EPOCH_ZERO))
      .toEqual({ compact_threshold: 300, compact_threshold_chars: 32000 });
    expect(resolveActionConfig({ compact_threshold: 100, compact_threshold_chars: 40000 }, EPOCH_ZERO))
      .toEqual({ compact_threshold: 200, compact_threshold_chars: 40000 });
  });

  it('values edited since the update are kept even when they equal the legacy defaults', () => {
    expect(resolveActionConfig({ compact_threshold: 100, compact_threshold_chars: 16000 }, editedTs()))
      .toEqual({ compact_threshold: 100, compact_threshold_chars: 16000 });
  });

  it('custom values are clamped into the slider range', () => {
    expect(resolveActionConfig({ compact_threshold: 40, compact_threshold_chars: 6000 }, EPOCH_ZERO))
      .toEqual({ compact_threshold: 100, compact_threshold_chars: 16000 });
    expect(resolveActionConfig({ compact_threshold: 900, compact_threshold_chars: 200000 }, editedTs()))
      .toEqual({ compact_threshold: 500, compact_threshold_chars: 80000 });
    expect(resolveActionConfig({ compact_threshold: 350, compact_threshold_chars: 24000 }, editedTs()))
      .toEqual({ compact_threshold: 350, compact_threshold_chars: 24000 });
  });

  it('non-integer or non-positive values resolve to the defaults', () => {
    expect(resolveActionConfig({ compact_threshold: 0, compact_threshold_chars: -5 }, editedTs())).toEqual(DEFAULTS);
    expect(resolveActionConfig({ compact_threshold: '300', compact_threshold_chars: 2.5 }, editedTs())).toEqual(DEFAULTS);
  });

  it('readActionConfig resolves the stored config against its sync timestamp', async () => {
    const get = vi.fn(async () => ({
      'user_prompts:action_config': { compact_threshold: 100, compact_threshold_chars: 16000 },
      'device_sync_ts:actionConfig': EPOCH_ZERO,
    }));
    globalThis.browser.storage.local = { get };

    expect(await readActionConfig()).toEqual(DEFAULTS);
    expect(get).toHaveBeenCalledWith(['user_prompts:action_config', 'device_sync_ts:actionConfig']);
  });
});
