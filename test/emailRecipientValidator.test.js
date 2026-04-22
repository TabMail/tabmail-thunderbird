// Tests for validateAndNormalizeRecipientSets — the shared validator that
// email_forward / email_compose call with `requireRecipients: true`.
//
// email_reply used to call this validator too, but moved to delta semantics
// (add_recipients / remove_recipients / ...) at v1.5.16 and no longer
// participates in this contract. The `requireRecipients: false` cases below
// document the validator's behavior for any future caller that wants full-
// replace semantics without the "recipients required" guard.

import { describe, it, expect, vi } from 'vitest';

// Minimal globalThis mocks so the module can import.
globalThis.browser = globalThis.browser || {
  storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
};

// Mock the normalize step so we exercise only shape/validation logic. The real
// normalizer pulls in compose-window browser APIs that aren't available in vitest.
vi.mock('../chat/modules/contacts.js', () => ({
  normalizeRecipients: vi.fn(async (list) => list),
}));

// Other transitive imports that only matter at runtime, not at shape-validate time.
vi.mock('../agent/modules/composeTracker.js', () => ({ trackComposeWindow: vi.fn() }));
vi.mock('../agent/modules/idbStorage.js', () => ({}));
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
  getIdentityForMessage: vi.fn(),
}));
vi.mock('../chat/modules/context.js', () => ({ ctx: {} }));
vi.mock('../chat/modules/chatConfig.js', () => ({ CHAT_SETTINGS: {} }));
vi.mock('../chat/modules/helpers.js', () => ({ initialiseEmailCompose: vi.fn(), streamText: vi.fn() }));
vi.mock('../chat/chat.js', () => ({ createNewAgentBubble: vi.fn() }));
vi.mock('../chat/modules/converse.js', () => ({ awaitUserInput: vi.fn() }));
vi.mock('../chatlink/modules/core.js', () => ({ isChatLinkMessage: vi.fn(() => false) }));
vi.mock('../chatlink/modules/fsm.js', () => ({ relayFsmConfirmation: vi.fn() }));
vi.mock('../chatlink/modules/compose.js', () => ({
  waitForComposeReady: vi.fn(),
  setComposeBody: vi.fn(),
  sendComposedEmail: vi.fn(),
}));

const { validateAndNormalizeRecipientSets } = await import('../chat/fsm/emailCompose.js');

describe('validateAndNormalizeRecipientSets', () => {
  describe('requireRecipients: false (full-replace without requiring recipients)', () => {
    it('cc-only call passes when the recipients key is omitted', async () => {
      const vr = await validateAndNormalizeRecipientSets(
        { cc: [{ name: 'Eric Hedlin', email: 'iamerichedlin@gmail.com' }] },
        { requireRecipients: false }
      );
      expect(vr.ok).toBe(true);
      expect(vr.recipients).toEqual([]);
      expect(vr.cc).toEqual([{ name: 'Eric Hedlin', email: 'iamerichedlin@gmail.com' }]);
      expect(vr.bcc).toEqual([]);
    });

    it('explicitly passing recipients: [] is rejected as "invalid empty override"', async () => {
      // "Present but empty" means the caller tried to override with nothing.
      // Callers must omit the key instead of passing an empty array.
      const vr = await validateAndNormalizeRecipientSets(
        { recipients: [], cc: [{ email: 'a@b.com' }] },
        { requireRecipients: false }
      );
      expect(vr.ok).toBe(false);
      expect(vr.code).toBe('invalid_recipients_array');
      expect(vr.field).toBe('recipients');
    });

    it('bcc-only override passes', async () => {
      const vr = await validateAndNormalizeRecipientSets(
        { bcc: [{ email: 'a@b.com' }] },
        { requireRecipients: false }
      );
      expect(vr.ok).toBe(true);
      expect(vr.bcc).toEqual([{ email: 'a@b.com' }]);
    });

    it('all-fields override passes', async () => {
      const vr = await validateAndNormalizeRecipientSets(
        {
          recipients: [{ email: 'to@x.com' }],
          cc: [{ email: 'cc@x.com' }],
          bcc: [{ email: 'bcc@x.com' }],
        },
        { requireRecipients: false }
      );
      expect(vr.ok).toBe(true);
      expect(vr.recipients).toEqual([{ email: 'to@x.com' }]);
      expect(vr.cc).toEqual([{ email: 'cc@x.com' }]);
      expect(vr.bcc).toEqual([{ email: 'bcc@x.com' }]);
    });

    it('no overrides at all returns ok with empty lists (caller applies its own defaults)', async () => {
      const vr = await validateAndNormalizeRecipientSets({}, { requireRecipients: false });
      expect(vr.ok).toBe(true);
      expect(vr.recipients).toEqual([]);
      expect(vr.cc).toEqual([]);
      expect(vr.bcc).toEqual([]);
    });

    it('recipient with missing email field is rejected', async () => {
      const vr = await validateAndNormalizeRecipientSets(
        { cc: [{ name: 'nobody' }] },
        { requireRecipients: false }
      );
      expect(vr.ok).toBe(false);
      expect(vr.field).toBe('cc');
      expect(vr.index).toBe(0);
    });
  });

  describe('requireRecipients: true (compose/forward flow — recipients mandatory)', () => {
    it('rejects when recipients is missing entirely', async () => {
      const vr = await validateAndNormalizeRecipientSets({}, { requireRecipients: true });
      expect(vr.ok).toBe(false);
      expect(vr.code).toBe('missing_recipients');
    });

    it('rejects when recipients is empty array', async () => {
      const vr = await validateAndNormalizeRecipientSets(
        { recipients: [] },
        { requireRecipients: true }
      );
      expect(vr.ok).toBe(false);
      expect(vr.code).toBe('missing_recipients');
    });

    it('passes with a valid recipients list', async () => {
      const vr = await validateAndNormalizeRecipientSets(
        { recipients: [{ email: 'to@x.com' }] },
        { requireRecipients: true }
      );
      expect(vr.ok).toBe(true);
      expect(vr.recipients).toEqual([{ email: 'to@x.com' }]);
    });
  });
});
