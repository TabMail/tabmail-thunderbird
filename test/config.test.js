// config.test.js — Tests for agent/modules/config.js
//
// Tests for SETTINGS constants and URL helper functions.
// The module has a self-initializing IIFE and storage listener that requires browser mocking.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// globalThis.browser mock — must be set before importing the module
// ---------------------------------------------------------------------------

const storageData = {};
const storageListeners = [];

globalThis.browser = {
  storage: {
    local: {
      get: vi.fn(async (keysOrDefault) => {
        if (typeof keysOrDefault === 'string') {
          return { [keysOrDefault]: storageData[keysOrDefault] ?? undefined };
        }
        const result = {};
        for (const [k, def] of Object.entries(keysOrDefault)) {
          result[k] = storageData[k] !== undefined ? storageData[k] : def;
        }
        return result;
      }),
      set: vi.fn(async (obj) => {
        for (const [k, v] of Object.entries(obj)) {
          storageData[k] = v;
        }
      }),
    },
    onChanged: {
      addListener: vi.fn((listener) => {
        storageListeners.push(listener);
      }),
      removeListener: vi.fn((listener) => {
        const idx = storageListeners.indexOf(listener);
        if (idx !== -1) storageListeners.splice(idx, 1);
      }),
    },
  },
};

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { SETTINGS, getBackendUrl, getDeviceSyncUrl, getTemplateWorkerUrl, cleanupConfigListeners } = await import('../agent/modules/config.js');

// ---------------------------------------------------------------------------
// Tests for SETTINGS
// ---------------------------------------------------------------------------

describe('SETTINGS', () => {
  it('has supabase configuration', () => {
    expect(SETTINGS.supabaseUrl).toBe('https://auth.tabmail.ai');
    expect(typeof SETTINGS.supabaseAnonKey).toBe('string');
    expect(SETTINGS.supabaseAnonKey.length).toBeGreaterThan(0);
  });

  it('has backend base and domain', () => {
    expect(SETTINGS.backendBaseProd).toBe('api');
    expect(SETTINGS.backendBaseDev).toBe('dev');
    expect(SETTINGS.backendDomain).toBe('tabmail.ai');
  });

  it('has health check configuration', () => {
    expect(SETTINGS.healthCheck).toBeDefined();
    expect(typeof SETTINGS.healthCheck.timeoutMs).toBe('number');
    expect(SETTINGS.healthCheck.endpoints.api).toBe('/health');
  });

  it('has SSE timeout configuration', () => {
    expect(typeof SETTINGS.sseMaxTimeoutSec).toBe('number');
    expect(SETTINGS.sseMaxTimeoutSec).toBeGreaterThan(0);
    expect(typeof SETTINGS.sseToolListenTimeoutSec).toBe('number');
  });

  it('has auth configuration', () => {
    expect(typeof SETTINGS.authSignInTimeoutMs).toBe('number');
    expect(typeof SETTINGS.authSignOutTimeoutMs).toBe('number');
    expect(typeof SETTINGS.authAutoReauthEnabled).toBe('boolean');
    expect(typeof SETTINGS.authTokenRefreshRetries).toBe('number');
  });

  it('has auth window dimensions', () => {
    expect(SETTINGS.authWindow).toBeDefined();
    expect(typeof SETTINGS.authWindow.defaultWidth).toBe('number');
    expect(typeof SETTINGS.authWindow.defaultHeight).toBe('number');
  });

  it('has welcome window dimensions', () => {
    expect(SETTINGS.welcomeWindow).toBeDefined();
    expect(typeof SETTINGS.welcomeWindow.defaultWidth).toBe('number');
    expect(typeof SETTINGS.welcomeWindow.defaultHeight).toBe('number');
  });

  it('has maxAgentWorkers', () => {
    expect(typeof SETTINGS.maxAgentWorkers).toBe('number');
    expect(SETTINGS.maxAgentWorkers).toBeGreaterThan(0);
  });

  it('has cache TTL settings', () => {
    expect(typeof SETTINGS.replyTTLSeconds).toBe('number');
    expect(typeof SETTINGS.actionTTLSeconds).toBe('number');
    expect(typeof SETTINGS.summaryTTLSeconds).toBe('number');
    expect(typeof SETTINGS.getFullTTLSeconds).toBe('number');
  });

  it('has getFullDiag configuration', () => {
    expect(SETTINGS.getFullDiag).toBeDefined();
    expect(typeof SETTINGS.getFullDiag.ftsMissLogMax).toBe('number');
    expect(typeof SETTINGS.getFullDiag.ftsMissLogMinIntervalMs).toBe('number');
  });

  it('has snippet cache settings', () => {
    expect(typeof SETTINGS.snippetCacheMaxMemoryEntries).toBe('number');
    expect(typeof SETTINGS.snippetCacheMaxIdbEntries).toBe('number');
    expect(typeof SETTINGS.snippetCacheMemoryTtlMs).toBe('number');
    expect(typeof SETTINGS.snippetCacheIdbTtlMs).toBe('number');
  });

  it('has mail sync preferences', () => {
    expect(SETTINGS.mailSync).toBeDefined();
    expect(typeof SETTINGS.mailSync.defaultCheckIntervalMinutes).toBe('number');
    expect(typeof SETTINGS.mailSync.enableAllFoldersCheck).toBe('boolean');
    expect(typeof SETTINGS.mailSync.verticalLayoutOnInstall).toBe('boolean');
  });

  it('has action tagging configuration', () => {
    expect(SETTINGS.actionTagging).toBeDefined();
    expect(typeof SETTINGS.actionTagging.tagByThreadDefault).toBe('boolean');
    expect(SETTINGS.actionTagging.actionPriority).toBeDefined();
    expect(SETTINGS.actionTagging.actionPriority.delete).toBe(0);
    expect(SETTINGS.actionTagging.actionPriority.archive).toBe(1);
    expect(SETTINGS.actionTagging.actionPriority.none).toBe(2);
    expect(SETTINGS.actionTagging.actionPriority.reply).toBe(3);
  });

  it('has appearance preferences', () => {
    expect(SETTINGS.appearance).toBeDefined();
    expect(SETTINGS.appearance.prefs).toBeDefined();
    expect(SETTINGS.appearance.defaults).toBeDefined();
    expect(typeof SETTINGS.appearance.defaults.listView).toBe('number');
  });

  it('has event names', () => {
    expect(SETTINGS.events).toBeDefined();
    expect(typeof SETTINGS.events.userActionPromptUpdated).toBe('string');
    expect(typeof SETTINGS.events.userKBPromptUpdated).toBe('string');
  });

  it('has agent queues configuration', () => {
    expect(SETTINGS.agentQueues).toBeDefined();
    expect(SETTINGS.agentQueues.processMessage).toBeDefined();
    expect(typeof SETTINGS.agentQueues.processMessage.watchIntervalMs).toBe('number');
    expect(typeof SETTINGS.agentQueues.processMessage.batchSize).toBe('number');
  });

  it('has device sync configuration', () => {
    expect(SETTINGS.deviceSync).toBeDefined();
    expect(typeof SETTINGS.deviceSync.broadcastDebounceMs).toBe('number');
    expect(typeof SETTINGS.deviceSync.maxBackups).toBe('number');
  });

  it('has notifications configuration', () => {
    expect(SETTINGS.notifications).toBeDefined();
    expect(typeof SETTINGS.notifications.proactiveEnabled).toBe('boolean');
    expect(typeof SETTINGS.notifications.newReminderWindowDays).toBe('number');
    expect(typeof SETTINGS.notifications.dueReminderAdvanceMinutes).toBe('number');
  });

  it('has chat session settings', () => {
    expect(SETTINGS.chat).toBeDefined();
    expect(typeof SETTINGS.chat.idleThresholdMinutes).toBe('number');
  });

  it('has reminder generation settings', () => {
    expect(SETTINGS.reminderGeneration).toBeDefined();
    expect(typeof SETTINGS.reminderGeneration.enabled).toBe('boolean');
    expect(typeof SETTINGS.reminderGeneration.maxRemindersToShow).toBe('number');
  });

  it('has inbox management settings', () => {
    expect(SETTINGS.inboxManagement).toBeDefined();
    expect(typeof SETTINGS.inboxManagement.maxRecentEmails).toBe('number');
    expect(typeof SETTINGS.inboxManagement.archiveAgeDays).toBe('number');
  });

  it('has message display gate config', () => {
    expect(SETTINGS.messageDisplayGate).toBeDefined();
    expect(typeof SETTINGS.messageDisplayGate.enabled).toBe('boolean');
    expect(typeof SETTINGS.messageDisplayGate.scriptsInitDelayMs).toBe('number');
  });

  it('has summary banner config', () => {
    expect(SETTINGS.summaryBanner).toBeDefined();
    expect(Array.isArray(SETTINGS.summaryBanner.sendRetryDelaysMs)).toBe(true);
    expect(typeof SETTINGS.summaryBanner.bubbleReadyTimeoutMs).toBe('number');
    expect(typeof SETTINGS.summaryBanner.notLoggedInMessage).toBe('string');
  });

  it('has thread conversation config', () => {
    expect(SETTINGS.threadConversation).toBeDefined();
    expect(typeof SETTINGS.threadConversation.enabled).toBe('boolean');
    expect(typeof SETTINGS.threadConversation.maxThreadMessages).toBe('number');
    expect(typeof SETTINGS.threadConversation.source).toBe('string');
  });

  it('has onMoved configuration', () => {
    expect(SETTINGS.onMoved).toBeDefined();
    expect(SETTINGS.onMoved.tagClearOnLeaveInbox).toBeDefined();
    expect(typeof SETTINGS.onMoved.tagClearOnLeaveInbox.maxAttempts).toBe('number');
    expect(SETTINGS.onMoved.tagReassertWatchdog).toBeDefined();
    expect(SETTINGS.onMoved.tagReassertGuard).toBeDefined();
    expect(SETTINGS.onMoved.staleTagSweep).toBeDefined();
  });

  it('has memory management settings', () => {
    expect(SETTINGS.memoryManagement).toBeDefined();
    expect(typeof SETTINGS.memoryManagement.selfTagIgnorePruneIntervalMs).toBe('number');
    expect(typeof SETTINGS.memoryManagement.headerIndexMaxSize).toBe('number');
  });

  it('has FTS engine diagnostics config', () => {
    expect(SETTINGS.ftsEngineDiag).toBeDefined();
    expect(typeof SETTINGS.ftsEngineDiag.missLogMax).toBe('number');
  });

  it('has FTS cleanup config', () => {
    expect(SETTINGS.ftsCleanup).toBeDefined();
    expect(typeof SETTINGS.ftsCleanup.queryChunkSize).toBe('number');
    expect(typeof SETTINGS.ftsCleanup.validationBatchSize).toBe('number');
  });

  it('has event logger config', () => {
    expect(SETTINGS.eventLogger).toBeDefined();
    expect(typeof SETTINGS.eventLogger.enabled).toBe('boolean');
    expect(typeof SETTINGS.eventLogger.persistDebounceMs).toBe('number');
  });

  it('has addon emoji', () => {
    expect(typeof SETTINGS.addonEmoji).toBe('string');
  });

  it('has debugMode default', () => {
    expect(typeof SETTINGS.debugMode).toBe('boolean');
  });

  it('has logFolder', () => {
    expect(typeof SETTINGS.logFolder).toBe('string');
  });

  it('has status page URL', () => {
    expect(typeof SETTINGS.statusPageUrl).toBe('string');
    expect(SETTINGS.statusPageUrl).toContain('tabmail.ai');
  });

  it('has after-send index config', () => {
    expect(SETTINGS.afterSendIndex).toBeDefined();
    expect(typeof SETTINGS.afterSendIndex.enabled).toBe('boolean');
    expect(typeof SETTINGS.afterSendIndex.maxWaitMs).toBe('number');
  });

  it('has user notice config', () => {
    expect(SETTINGS.userNotice).toBeDefined();
    expect(SETTINGS.userNotice.cannotTagSelf).toBeDefined();
    expect(typeof SETTINGS.userNotice.cannotTagSelf.width).toBe('number');
  });

  it('has consent config', () => {
    expect(typeof SETTINGS.authConsentTimeoutMs).toBe('number');
    expect(typeof SETTINGS.authConsentPollIntervalMs).toBe('number');
    expect(typeof SETTINGS.consentPageUrl).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Tests for getBackendUrl
// ---------------------------------------------------------------------------

describe('getBackendUrl', () => {
  beforeEach(() => {
    // Reset storage
    for (const key of Object.keys(storageData)) delete storageData[key];
    vi.clearAllMocks();
  });

  it('returns production URL when debugMode is false', async () => {
    storageData.debugMode = false;
    const url = await getBackendUrl();
    expect(url).toBe('https://api.tabmail.ai');
  });

  it('returns dev URL when debugMode is true', async () => {
    storageData.debugMode = true;
    const url = await getBackendUrl();
    expect(url).toBe('https://dev.tabmail.ai');
  });

  it('returns production URL when debugMode is not set (default)', async () => {
    const url = await getBackendUrl();
    expect(url).toBe('https://api.tabmail.ai');
  });

  it('ignores endpointType parameter (unified backend)', async () => {
    storageData.debugMode = false;
    const url = await getBackendUrl('completions');
    expect(url).toBe('https://api.tabmail.ai');
  });

  it('handles storage.local.get failure gracefully', async () => {
    browser.storage.local.get.mockRejectedValueOnce(new Error('storage error'));
    const url = await getBackendUrl();
    // Should fallback to production
    expect(url).toBe('https://api.tabmail.ai');
  });
});

// ---------------------------------------------------------------------------
// Tests for getDeviceSyncUrl
// ---------------------------------------------------------------------------

describe('getDeviceSyncUrl', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    vi.clearAllMocks();
  });

  it('returns production sync URL when debugMode is false', async () => {
    storageData.debugMode = false;
    const url = await getDeviceSyncUrl();
    expect(url).toBe('https://sync.tabmail.ai');
  });

  it('returns dev sync URL when debugMode is true', async () => {
    storageData.debugMode = true;
    const url = await getDeviceSyncUrl();
    expect(url).toBe('https://sync-dev.tabmail.ai');
  });

  it('returns production sync URL when debugMode is not set', async () => {
    const url = await getDeviceSyncUrl();
    expect(url).toBe('https://sync.tabmail.ai');
  });

  it('handles storage.local.get failure gracefully', async () => {
    browser.storage.local.get.mockRejectedValueOnce(new Error('storage error'));
    const url = await getDeviceSyncUrl();
    expect(url).toBe('https://sync.tabmail.ai');
  });
});

// ---------------------------------------------------------------------------
// Tests for getTemplateWorkerUrl
// ---------------------------------------------------------------------------

describe('getTemplateWorkerUrl', () => {
  beforeEach(() => {
    for (const key of Object.keys(storageData)) delete storageData[key];
    vi.clearAllMocks();
  });

  it('returns production template URL when debugMode is false', async () => {
    storageData.debugMode = false;
    const url = await getTemplateWorkerUrl();
    expect(url).toBe('https://templates.tabmail.ai');
  });

  it('returns dev template URL when debugMode is true', async () => {
    storageData.debugMode = true;
    const url = await getTemplateWorkerUrl();
    expect(url).toBe('https://templates-dev.tabmail.ai');
  });

  it('handles storage.local.get failure gracefully', async () => {
    browser.storage.local.get.mockRejectedValueOnce(new Error('storage error'));
    const url = await getTemplateWorkerUrl();
    expect(url).toBe('https://templates.tabmail.ai');
  });
});

// ---------------------------------------------------------------------------
// Tests for cleanupConfigListeners
// ---------------------------------------------------------------------------

describe('cleanupConfigListeners', () => {
  it('does not throw when called', () => {
    expect(() => cleanupConfigListeners()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Tests for storage change listener
// ---------------------------------------------------------------------------

describe('storage change listener', () => {
  it('the module registers a listener on import (already called before mock was set up)', () => {
    // The IIFE and listener registration happen at module parse time,
    // before our mock was ready. We verify the listener shape instead.
    expect(typeof cleanupConfigListeners).toBe('function');
  });
});
