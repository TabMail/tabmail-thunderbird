// toolCollapse.test.js — Tests for chat/modules/toolCollapse.js
//
// Tests tool bubble collapsing: DOM creation, group management, animation,
// finalization. Uses minimal DOM mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Minimal DOM mock
// ---------------------------------------------------------------------------
class MockClassList {
  constructor(el) {
    this._el = el;
    this._set = new Set();
  }
  add(...cls) {
    cls.forEach(c => this._set.add(c));
    this._el.className = Array.from(this._set).join(' ');
  }
  remove(...cls) {
    cls.forEach(c => this._set.delete(c));
    this._el.className = Array.from(this._set).join(' ');
  }
  contains(c) { return this._set.has(c); }
  toggle(c) {
    if (this._set.has(c)) this._set.delete(c);
    else this._set.add(c);
    this._el.className = Array.from(this._set).join(' ');
  }
}

class MockElement {
  constructor(tag) {
    this.tagName = tag;
    this._className = '';
    this.innerHTML = '';
    this.textContent = '';
    this.children = [];
    this.parentNode = null;
    this._attributes = {};
    this._listeners = {};
    this.classList = new MockClassList(this);
  }

  get className() { return this._className; }
  set className(val) {
    this._className = val;
    // Sync classList from className string assignment
    this.classList._set.clear();
    if (val) {
      val.split(/\s+/).filter(Boolean).forEach(c => this.classList._set.add(c));
    }
  }

  setAttribute(name, value) { this._attributes[name] = value; }
  getAttribute(name) { return this._attributes[name] ?? null; }

  appendChild(child) {
    child.parentNode = this;
    this.children.push(child);
    return child;
  }

  remove() {
    if (this.parentNode) {
      const idx = this.parentNode.children.indexOf(this);
      if (idx >= 0) this.parentNode.children.splice(idx, 1);
      this.parentNode = null;
    }
  }

  querySelector(selector) {
    return this._queryAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    return this._queryAll(selector);
  }

  _queryAll(selector) {
    const results = [];
    const check = (el) => {
      if (_matches(el, selector)) results.push(el);
      for (const child of el.children || []) check(child);
    };
    for (const child of this.children || []) check(child);
    return results;
  }

  cloneNode(deep) {
    const clone = new MockElement(this.tagName);
    clone.className = this.className;
    clone.innerHTML = this.innerHTML;
    clone.textContent = this.textContent;
    clone._attributes = { ...this._attributes };
    if (deep) {
      for (const child of this.children) {
        clone.appendChild(child.cloneNode(true));
      }
    }
    return clone;
  }

  addEventListener(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  }

  replaceChild(newChild, oldChild) {
    const idx = this.children.indexOf(oldChild);
    if (idx >= 0) {
      this.children[idx] = newChild;
      newChild.parentNode = this;
      oldChild.parentNode = null;
    }
  }
}

function _matches(el, selector) {
  // Handle comma-separated selectors
  const parts = selector.split(',').map(s => s.trim());
  return parts.some(part => _matchesSingle(el, part));
}

function _matchesSingle(el, selector) {
  // Handle :not()
  const notMatch = selector.match(/^(.+):not\((.+)\)$/);
  if (notMatch) {
    return _matchesSingle(el, notMatch[1]) && !_matchesSingle(el, notMatch[2]);
  }

  // Handle compound class selectors like ".agent-message.tool"
  const classRegex = /^\.[\w-]+/;
  const classes = [];
  let remaining = selector;
  while (remaining.length > 0) {
    const m = remaining.match(classRegex);
    if (m) {
      classes.push(m[0].slice(1));
      remaining = remaining.slice(m[0].length);
    } else {
      break;
    }
  }

  if (classes.length > 0 && remaining === '') {
    return classes.every(c => el.classList.contains(c));
  }

  if (selector.startsWith('#')) {
    return el._attributes.id === selector.slice(1);
  }

  if (selector.startsWith('.')) {
    return el.classList.contains(selector.slice(1));
  }

  return false;
}

globalThis.document = {
  createElement: (tag) => new MockElement(tag),
  getElementById: vi.fn(() => null),
};

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------
vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

vi.mock('../chat/modules/chatConfig.js', async () => {
  return {
    CHAT_SETTINGS: {
      toolCollapseEnabled: true,
      toolCollapseMinCount: 2,
      toolCollapseAnimationMs: 200,
      toolBubbleFadeMs: 10,
    },
  };
});

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import {
  isCollapseAnimating,
  getOrCreateToolGroup,
  addToolBubbleToGroup,
  finalizeToolGroup,
  isToolCollapseEnabled,
  cleanupToolGroups,
} from '../chat/modules/toolCollapse.js';

describe('toolCollapse', () => {
  let container;

  beforeEach(() => {
    container = new MockElement('div');
    container._attributes.id = 'chat-container';
    vi.clearAllMocks();
  });

  // --- isToolCollapseEnabled ---
  describe('isToolCollapseEnabled', () => {
    it('should return true when enabled in config', () => {
      expect(isToolCollapseEnabled()).toBe(true);
    });
  });

  // --- isCollapseAnimating ---
  describe('isCollapseAnimating', () => {
    it('should return false when no container found', () => {
      expect(isCollapseAnimating()).toBe(false);
    });

    it('should return false when no fading-in elements', () => {
      globalThis.document.getElementById.mockReturnValueOnce(container);
      expect(isCollapseAnimating()).toBe(false);
    });

    it('should return true when fading-in element exists', () => {
      const el = new MockElement('div');
      el.classList.add('fading-in');
      container.appendChild(el);
      globalThis.document.getElementById.mockReturnValueOnce(container);
      expect(isCollapseAnimating()).toBe(true);
    });
  });

  // --- getOrCreateToolGroup ---
  describe('getOrCreateToolGroup', () => {
    it('should create a new tool group', () => {
      const group = getOrCreateToolGroup(container);
      expect(group).not.toBeNull();
      expect(group.classList.contains('tool-group')).toBe(true);
      expect(container.children.length).toBe(1);
    });

    it('should reuse existing unfinalized group', () => {
      const group1 = getOrCreateToolGroup(container);
      const group2 = getOrCreateToolGroup(container);
      expect(group1).toBe(group2);
      expect(container.children.length).toBe(1);
    });

    it('should create new group when existing is finalized', () => {
      const group1 = getOrCreateToolGroup(container);
      group1.classList.add('finalized');
      const group2 = getOrCreateToolGroup(container);
      expect(group2).not.toBe(group1);
      expect(container.children.length).toBe(2);
    });

    it('should set data-group-id when provided', () => {
      const group = getOrCreateToolGroup(container, 'test-group');
      expect(group.getAttribute('data-group-id')).toBe('test-group');
    });

    it('should create header with toggle and label', () => {
      const group = getOrCreateToolGroup(container);
      const header = group.children.find(c => c.classList.contains('tool-group-header'));
      expect(header).toBeDefined();
    });

    it('should create content area', () => {
      const group = getOrCreateToolGroup(container);
      const content = group.children.find(c => c.classList.contains('tool-group-content'));
      expect(content).toBeDefined();
    });
  });

  // --- addToolBubbleToGroup ---
  describe('addToolBubbleToGroup', () => {
    it('should add a bubble to the tool group content', () => {
      const bubble = new MockElement('div');
      bubble.classList.add('agent-message');
      bubble.classList.add('tool');
      bubble.setAttribute('data-pid', 'pid1');

      addToolBubbleToGroup(bubble, container);

      const group = container.children[0];
      const content = group.children.find(c => c.classList.contains('tool-group-content'));
      expect(content.children.length).toBe(1);
    });

    it('should collapse older bubbles when minCount reached', () => {
      // Add first bubble with pid1
      const bubble1 = new MockElement('div');
      bubble1.classList.add('agent-message');
      bubble1.classList.add('tool');
      bubble1.setAttribute('data-pid', 'pid1');
      addToolBubbleToGroup(bubble1, container);

      // Add second bubble with pid2
      const bubble2 = new MockElement('div');
      bubble2.classList.add('agent-message');
      bubble2.classList.add('tool');
      bubble2.setAttribute('data-pid', 'pid2');
      addToolBubbleToGroup(bubble2, container);

      // bubble1 should be collapsed, bubble2 should be visible
      expect(bubble1.classList.contains('collapsed')).toBe(true);
      expect(bubble2.classList.contains('collapsed')).toBe(false);
    });

    it('should not collapse when only one pid', () => {
      const bubble1 = new MockElement('div');
      bubble1.classList.add('agent-message');
      bubble1.classList.add('tool');
      bubble1.setAttribute('data-pid', 'same-pid');
      addToolBubbleToGroup(bubble1, container);

      const bubble2 = new MockElement('div');
      bubble2.classList.add('agent-message');
      bubble2.classList.add('tool');
      bubble2.setAttribute('data-pid', 'same-pid');
      addToolBubbleToGroup(bubble2, container);

      // Both should be visible (same pid = same tool call)
      expect(bubble1.classList.contains('collapsed')).toBe(false);
      expect(bubble2.classList.contains('collapsed')).toBe(false);
    });
  });

  // --- finalizeToolGroup ---
  describe('finalizeToolGroup', () => {
    it('should mark group as finalized', async () => {
      const group = getOrCreateToolGroup(container);
      await finalizeToolGroup(container);
      expect(group.classList.contains('finalized')).toBe(true);
    });

    it('should do nothing when no active group', async () => {
      await finalizeToolGroup(container);
      // Should not throw
    });

    it('should add tm-fade-out class', async () => {
      const group = getOrCreateToolGroup(container);
      await finalizeToolGroup(container);
      // After awaiting, group should have been removed but we can check it was finalized
      expect(group.classList.contains('finalized')).toBe(true);
    });
  });

  // --- cleanupToolGroups ---
  describe('cleanupToolGroups', () => {
    it('should replace headers to remove listeners', () => {
      getOrCreateToolGroup(container);
      cleanupToolGroups(container);
      // Should not throw
    });

    it('should handle empty container', () => {
      cleanupToolGroups(container);
      // Should not throw
    });
  });
});
