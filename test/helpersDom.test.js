// helpersDom.test.js — Tests for chat/modules/helpers.js DOM-dependent functions
//
// Tests for extractTextFromBubble, scrollToBottom, setBubbleText, streamText
// These need DOM mocks (document, requestAnimationFrame, etc.)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../agent/modules/config.js', () => ({
  SETTINGS: {
    verboseLogging: false,
    debugLogging: false,
    debugMode: false,
    logTruncateLength: 100,
    getFullDiag: {},
  },
}));

vi.mock('../agent/modules/thinkBuffer.js', () => ({
  getAndClearThink: vi.fn(() => null),
}));

vi.mock('../agent/modules/quoteAndSignature.js', () => ({}));

vi.mock('../chat/modules/chatConfig.js', () => ({
  CHAT_SETTINGS: {
    streamDelayMs: 5,
    scrollFramesOnAppend: 1,
    scrollFramesOnMutation: 1,
    scrollBackupDelays: [0],
    stickToBottomThresholdEm: 2,
  },
}));

vi.mock('../chat/modules/context.js', () => ({
  ctx: {},
}));

const mockRenderMarkdown = vi.fn(async (text) => `<p>${text}</p>`);
const mockAttachSpecialLinkListeners = vi.fn();

vi.mock('../chat/modules/markdown.js', () => ({
  attachSpecialLinkListeners: mockAttachSpecialLinkListeners,
  renderMarkdown: mockRenderMarkdown,
}));

// ---------------------------------------------------------------------------
// Minimal DOM shims for node environment
// ---------------------------------------------------------------------------

function createElement(tag) {
  const el = {
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    className: '',
    textContent: '',
    innerHTML: '',
    children: [],
    childNodes: [],
    style: {},
    __attributes: {},
    classList: {
      _classes: new Set(),
      add(cls) { this._classes.add(cls); },
      remove(cls) { this._classes.delete(cls); },
      contains(cls) { return this._classes.has(cls); },
    },
    appendChild(child) {
      this.children.push(child);
      this.childNodes.push(child);
      return child;
    },
    querySelector(sel) {
      // Simple selector matching for .bubble-content
      if (sel === '.bubble-content') {
        return this.children.find(c => c.className === 'bubble-content') || null;
      }
      return null;
    },
    querySelectorAll() { return []; },
    cloneNode(deep) {
      const clone = createElement(tag);
      clone.className = this.className;
      clone.textContent = this.textContent;
      clone.innerHTML = this.innerHTML;
      return clone;
    },
    remove() {},
    getAttribute(name) { return this.__attributes[name] || null; },
    setAttribute(name, value) { this.__attributes[name] = value; },
    get offsetWidth() { return 100; },
    get firstElementChild() { return this.children[0] || null; },
  };
  return el;
}

// Set up minimal document/window globals
beforeEach(() => {
  globalThis.document = {
    createElement,
    getElementById: vi.fn(() => null),
    createTextNode: (text) => ({ textContent: text, nodeName: '#text' }),
  };

  globalThis.window = globalThis.window || {};
  globalThis.window.getComputedStyle = vi.fn(() => ({ fontSize: '16px' }));
  globalThis.requestAnimationFrame = vi.fn((cb) => setTimeout(cb, 0));
  globalThis.setTimeout = globalThis.setTimeout;
  globalThis.clearInterval = globalThis.clearInterval;
  globalThis.setInterval = globalThis.setInterval;

  globalThis.browser = {
    accounts: { list: vi.fn(async () => []) },
  };

  mockRenderMarkdown.mockReset();
  mockRenderMarkdown.mockImplementation(async (text) => `<p>${text}</p>`);
  mockAttachSpecialLinkListeners.mockReset();
});

afterEach(() => {
  delete globalThis.document;
  delete globalThis.browser;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

const {
  extractTextFromBubble,
  scrollToBottom,
  setBubbleText,
  streamText,
  setStickToBottom,
  getStickToBottom,
  cleanupScrollObservers,
} = await import('../chat/modules/helpers.js');

// ---------------------------------------------------------------------------
// extractTextFromBubble
// ---------------------------------------------------------------------------
describe('extractTextFromBubble', () => {
  it('returns empty string for null bubble', () => {
    expect(extractTextFromBubble(null)).toBe('');
  });

  it('returns empty string for undefined bubble', () => {
    expect(extractTextFromBubble(undefined)).toBe('');
  });

  it('extracts text from bubble with .bubble-content child', () => {
    const bubble = createElement('div');
    const content = createElement('div');
    content.className = 'bubble-content';
    content.innerHTML = '<p>Hello world</p>';
    bubble.appendChild(content);

    const result = extractTextFromBubble(bubble);
    expect(result).toContain('Hello world');
  });

  it('falls back to bubble itself when no .bubble-content', () => {
    const bubble = createElement('div');
    bubble.innerHTML = '<p>Direct content</p>';

    const result = extractTextFromBubble(bubble);
    expect(result).toContain('Direct content');
  });

  it('handles bubble with empty innerHTML', () => {
    const bubble = createElement('div');
    bubble.innerHTML = '';

    const result = extractTextFromBubble(bubble);
    expect(result).toBe('');
  });

  it('handles bubble with HTML entities', () => {
    const bubble = createElement('div');
    bubble.innerHTML = '<p>A &amp; B</p>';

    const result = extractTextFromBubble(bubble);
    expect(result).toContain('A & B');
  });
});

// ---------------------------------------------------------------------------
// scrollToBottom
// ---------------------------------------------------------------------------
describe('scrollToBottom', () => {
  it('does nothing for null container', () => {
    // Should not throw
    scrollToBottom(null);
  });

  it('skips scroll when stickToBottom is false', () => {
    const container = {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 300,
      __tm_stickToBottom: false,
    };
    scrollToBottom(container, 1);
    // scrollTop should not change
    expect(container.scrollTop).toBe(0);
  });

  it('scrolls to bottom when stickToBottom is true', () => {
    const container = {
      scrollHeight: 1000,
      scrollTop: 0,
      clientHeight: 300,
      __tm_stickToBottom: true,
    };
    scrollToBottom(container, 1);
    expect(container.scrollTop).toBe(1000);
  });

  it('falls back to document.getElementById when no container passed', () => {
    globalThis.document.getElementById.mockReturnValueOnce(null);
    // Should not throw
    scrollToBottom(undefined, 1);
    expect(globalThis.document.getElementById).toHaveBeenCalledWith('chat-container');
  });
});

// ---------------------------------------------------------------------------
// setBubbleText (non-streaming)
// ---------------------------------------------------------------------------
describe('setBubbleText (non-streaming)', () => {
  it('sets innerHTML via renderMarkdown', async () => {
    const el = createElement('div');
    const content = createElement('div');
    content.className = 'bubble-content';
    el.appendChild(content);
    // _ensureBubbleContentElement will find existing .bubble-content or create one
    // Since our mock createElement doesn't create real DOM, test via the element directly

    mockRenderMarkdown.mockResolvedValueOnce('<p>Rendered</p>');
    await setBubbleText(el, 'Some text', { stream: false });
    expect(mockRenderMarkdown).toHaveBeenCalledWith('Some text');
  });

  it('handles empty text', async () => {
    const el = createElement('div');
    mockRenderMarkdown.mockResolvedValueOnce('');
    await setBubbleText(el, '', { stream: false });
    // Should not throw
  });

  it('falls back to textContent when renderMarkdown throws', async () => {
    const el = createElement('div');
    mockRenderMarkdown.mockRejectedValueOnce(new Error('render fail'));
    await setBubbleText(el, 'fallback text', { stream: false });
    // Should not throw - falls back to textContent
  });
});

// ---------------------------------------------------------------------------
// streamText
// ---------------------------------------------------------------------------
describe('streamText', () => {
  it('delegates to setBubbleText with stream=true', async () => {
    const el = createElement('div');
    mockRenderMarkdown.mockResolvedValueOnce('<p>streamed</p>');
    // streamText calls setBubbleText internally
    await streamText(el, 'streamed text');
    expect(mockRenderMarkdown).toHaveBeenCalled();
  });

  it('does not throw on error', async () => {
    const el = createElement('div');
    mockRenderMarkdown.mockRejectedValueOnce(new Error('fail'));
    // Should not throw
    await streamText(el, 'text');
  });
});

// ---------------------------------------------------------------------------
// cleanupScrollObservers
// ---------------------------------------------------------------------------
describe('cleanupScrollObservers', () => {
  it('does nothing for null container', () => {
    // Should not throw
    cleanupScrollObservers(null);
  });

  it('does nothing for container without observers', () => {
    const container = createElement('div');
    container.querySelectorAll = vi.fn(() => []);
    // Should not throw
    cleanupScrollObservers(container);
  });
});
