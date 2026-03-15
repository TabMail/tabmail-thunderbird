// chatConfig.test.js — Tests for chat/modules/chatConfig.js (TB-CFG-*)
//
// CHAT_SETTINGS is a pure config object — test that it exports expected keys
// with correct types and reasonable default values.

import { describe, it, expect } from 'vitest';
import { CHAT_SETTINGS } from '../chat/modules/chatConfig.js';

describe('CHAT_SETTINGS', () => {
  it('should be a non-null object', () => {
    expect(CHAT_SETTINGS).toBeDefined();
    expect(typeof CHAT_SETTINGS).toBe('object');
    expect(CHAT_SETTINGS).not.toBeNull();
  });

  // --- Chat window dimensions ---
  describe('chatWindow', () => {
    it('should have chatWindow with numeric width and height', () => {
      expect(CHAT_SETTINGS.chatWindow).toBeDefined();
      expect(typeof CHAT_SETTINGS.chatWindow.defaultWidth).toBe('number');
      expect(typeof CHAT_SETTINGS.chatWindow.defaultHeight).toBe('number');
      expect(CHAT_SETTINGS.chatWindow.defaultWidth).toBeGreaterThan(0);
      expect(CHAT_SETTINGS.chatWindow.defaultHeight).toBeGreaterThan(0);
    });
  });

  // --- Streaming ---
  describe('streaming settings', () => {
    it('should have valid streamMode', () => {
      expect(['block', 'line', 'char']).toContain(CHAT_SETTINGS.streamMode);
    });
    it('should have positive streamDelayMs', () => {
      expect(CHAT_SETTINGS.streamDelayMs).toBeGreaterThan(0);
    });
  });

  // --- Tool bubbles ---
  describe('tool bubble settings', () => {
    it('should have positive toolBubbleHoldMs', () => {
      expect(CHAT_SETTINGS.toolBubbleHoldMs).toBeGreaterThan(0);
    });
    it('should have positive toolBubbleFadeMs', () => {
      expect(CHAT_SETTINGS.toolBubbleFadeMs).toBeGreaterThan(0);
    });
  });

  // --- Search defaults ---
  describe('search settings', () => {
    it('should have positive searchDefaultLimit', () => {
      expect(CHAT_SETTINGS.searchDefaultLimit).toBeGreaterThan(0);
    });
    it('should have searchMaxLimit >= searchDefaultLimit', () => {
      expect(CHAT_SETTINGS.searchMaxLimit).toBeGreaterThanOrEqual(CHAT_SETTINGS.searchDefaultLimit);
    });
    it('should have positive searchDefaultDaysBack', () => {
      expect(CHAT_SETTINGS.searchDefaultDaysBack).toBeGreaterThan(0);
    });
    it('should have boolean useGlodaSearch', () => {
      expect(typeof CHAT_SETTINGS.useGlodaSearch).toBe('boolean');
    });
    it('should have boolean glodaIgnoreDate', () => {
      expect(typeof CHAT_SETTINGS.glodaIgnoreDate).toBe('boolean');
    });
    it('should have boolean useFtsSearch', () => {
      expect(typeof CHAT_SETTINGS.useFtsSearch).toBe('boolean');
    });
  });

  // --- FTS tunables ---
  describe('FTS settings', () => {
    it('should have positive ftsBatchSize', () => {
      expect(CHAT_SETTINGS.ftsBatchSize).toBeGreaterThan(0);
    });
    it('should have positive ftsMaxInflight', () => {
      expect(CHAT_SETTINGS.ftsMaxInflight).toBeGreaterThan(0);
    });
    it('should have positive ftsSleepBetweenBatchMs', () => {
      expect(CHAT_SETTINGS.ftsSleepBetweenBatchMs).toBeGreaterThan(0);
    });
    it('should have positive ftsMaxBatchBytes', () => {
      expect(CHAT_SETTINGS.ftsMaxBatchBytes).toBeGreaterThan(0);
    });
    it('should have boolean ftsInitialScanEnabled', () => {
      expect(typeof CHAT_SETTINGS.ftsInitialScanEnabled).toBe('boolean');
    });
    it('should have boolean ftsIncrementalEnabled', () => {
      expect(typeof CHAT_SETTINGS.ftsIncrementalEnabled).toBe('boolean');
    });
    it('should have boolean ftsMaintenanceEnabled', () => {
      expect(typeof CHAT_SETTINGS.ftsMaintenanceEnabled).toBe('boolean');
    });
  });

  // --- Contacts ---
  describe('contacts settings', () => {
    it('should have positive contactsQueryTimeoutMs', () => {
      expect(CHAT_SETTINGS.contactsQueryTimeoutMs).toBeGreaterThan(0);
    });
    it('should have boolean normalizeRecipientsFromContacts', () => {
      expect(typeof CHAT_SETTINGS.normalizeRecipientsFromContacts).toBe('boolean');
    });
    it('should have positive contactsDefaultLimit', () => {
      expect(CHAT_SETTINGS.contactsDefaultLimit).toBeGreaterThan(0);
    });
    it('should have contactsMaxLimit >= contactsDefaultLimit', () => {
      expect(CHAT_SETTINGS.contactsMaxLimit).toBeGreaterThanOrEqual(CHAT_SETTINGS.contactsDefaultLimit);
    });
  });

  // --- Pagination ---
  describe('pagination settings', () => {
    it('should have positive inboxPageSizeDefault', () => {
      expect(CHAT_SETTINGS.inboxPageSizeDefault).toBeGreaterThan(0);
    });
    it('should have positive inboxPageSizeMax', () => {
      expect(CHAT_SETTINGS.inboxPageSizeMax).toBeGreaterThan(0);
    });
    it('should have positive searchPageSizeDefault', () => {
      expect(CHAT_SETTINGS.searchPageSizeDefault).toBeGreaterThan(0);
    });
    it('should have positive calendarPageSizeDefault', () => {
      expect(CHAT_SETTINGS.calendarPageSizeDefault).toBeGreaterThan(0);
    });
  });

  // --- Calendar helpers ---
  describe('calendar settings', () => {
    it('should have msPerDay === 86400000', () => {
      expect(CHAT_SETTINGS.msPerDay).toBe(86400000);
    });
    it('should have positive calendarEntryMatchToleranceMs', () => {
      expect(CHAT_SETTINGS.calendarEntryMatchToleranceMs).toBeGreaterThan(0);
    });
    it('should have middayHourForDateHeader === 12', () => {
      expect(CHAT_SETTINGS.middayHourForDateHeader).toBe(12);
    });
    it('should have positive createEventDefaultDurationMinutes', () => {
      expect(CHAT_SETTINGS.createEventDefaultDurationMinutes).toBeGreaterThan(0);
    });
  });

  // --- Scrolling ---
  describe('scrolling settings', () => {
    it('should have positive stickToBottomThresholdEm', () => {
      expect(CHAT_SETTINGS.stickToBottomThresholdEm).toBeGreaterThan(0);
    });
    it('should have positive scrollFramesOnAppend', () => {
      expect(CHAT_SETTINGS.scrollFramesOnAppend).toBeGreaterThan(0);
    });
    it('should have scrollBackupDelays as non-empty array', () => {
      expect(Array.isArray(CHAT_SETTINGS.scrollBackupDelays)).toBe(true);
      expect(CHAT_SETTINGS.scrollBackupDelays.length).toBeGreaterThan(0);
    });
  });

  // --- Tool collapse ---
  describe('tool collapse settings', () => {
    it('should have boolean toolCollapseEnabled', () => {
      expect(typeof CHAT_SETTINGS.toolCollapseEnabled).toBe('boolean');
    });
    it('should have positive toolCollapseMinCount', () => {
      expect(CHAT_SETTINGS.toolCollapseMinCount).toBeGreaterThan(0);
    });
    it('should have positive toolCollapseAnimationMs', () => {
      expect(CHAT_SETTINGS.toolCollapseAnimationMs).toBeGreaterThan(0);
    });
  });

  // --- LLM retry ---
  describe('LLM retry settings', () => {
    it('should have positive llmEmptyResponseMaxRetries', () => {
      expect(CHAT_SETTINGS.llmEmptyResponseMaxRetries).toBeGreaterThan(0);
    });
  });

  // --- Headless compose ---
  describe('headless compose settings', () => {
    it('should have boolean headlessComposeEnabled', () => {
      expect(typeof CHAT_SETTINGS.headlessComposeEnabled).toBe('boolean');
    });
    it('should default to disabled', () => {
      expect(CHAT_SETTINGS.headlessComposeEnabled).toBe(false);
    });
  });

  // --- ChatLink FSM timeout ---
  describe('ChatLink settings', () => {
    it('should have non-negative chatLinkFsmTimeoutMs', () => {
      expect(CHAT_SETTINGS.chatLinkFsmTimeoutMs).toBeGreaterThanOrEqual(0);
    });
  });

  // --- Search summary mode ---
  describe('search summary mode', () => {
    it('should be one of the known modes', () => {
      expect(['cache_only', 'generate']).toContain(CHAT_SETTINGS.searchSummaryMode);
    });
  });

  // --- Prefetch ---
  describe('search prefetch settings', () => {
    it('should have positive searchPrefetchPagesDefault', () => {
      expect(CHAT_SETTINGS.searchPrefetchPagesDefault).toBeGreaterThan(0);
    });
    it('should have positive searchPrefetchMaxResults', () => {
      expect(CHAT_SETTINGS.searchPrefetchMaxResults).toBeGreaterThan(0);
    });
  });
});
