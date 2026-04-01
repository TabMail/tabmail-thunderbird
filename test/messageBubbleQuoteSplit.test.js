// messageBubbleQuoteSplit.test.js — Tests for messageBubble.js <pre> split logic
//
// When a plain-text email has the reply and "-----Original Message-----"
// inside a SINGLE <pre>, the quote collapse must split the <pre> so only
// the quoted portion is collapsed (not the user's reply above it).

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { runInNewContext } from 'vm';

// ---------------------------------------------------------------------------
// Minimal DOM implementation — just enough for setupCollapsibleQuotes
// ---------------------------------------------------------------------------

const NODE_ELEMENT = 1;
const NODE_TEXT = 3;

class DOMNode {
  constructor(type) {
    this.nodeType = type;
    this.parentNode = null;
    this.parentElement = null;
    this._children = [];
  }
  get childNodes() { return this._children; }
  get firstChild() { return this._children[0] || null; }
  get lastChild() { return this._children[this._children.length - 1] || null; }
  get nextSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode._children;
    const idx = sibs.indexOf(this);
    return idx >= 0 && idx < sibs.length - 1 ? sibs[idx + 1] : null;
  }
  get previousSibling() {
    if (!this.parentNode) return null;
    const sibs = this.parentNode._children;
    const idx = sibs.indexOf(this);
    return idx > 0 ? sibs[idx - 1] : null;
  }
  get textContent() {
    if (this.nodeType === NODE_TEXT) return this._data;
    return this._children.map(c => c.textContent).join('');
  }
  set textContent(val) {
    if (this.nodeType === NODE_TEXT) { this._data = val; return; }
    // Clear children and set a text node
    this._children.forEach(c => { c.parentNode = null; c.parentElement = null; });
    this._children = [];
    if (val) {
      const t = new DOMTextNode(val);
      this._appendChild(t);
    }
  }
  _appendChild(child) {
    if (child.parentNode) child.parentNode._removeChild(child);
    child.parentNode = this;
    child.parentElement = this.nodeType === NODE_ELEMENT ? this : null;
    this._children.push(child);
    return child;
  }
  _removeChild(child) {
    const idx = this._children.indexOf(child);
    if (idx >= 0) this._children.splice(idx, 1);
    child.parentNode = null;
    child.parentElement = null;
  }
  _insertBefore(newChild, refChild) {
    if (newChild.parentNode) newChild.parentNode._removeChild(newChild);
    newChild.parentNode = this;
    newChild.parentElement = this.nodeType === NODE_ELEMENT ? this : null;
    if (!refChild) {
      this._children.push(newChild);
    } else {
      const idx = this._children.indexOf(refChild);
      if (idx >= 0) this._children.splice(idx, 0, newChild);
      else this._children.push(newChild);
    }
    return newChild;
  }
}

class DOMTextNode extends DOMNode {
  constructor(data) {
    super(NODE_TEXT);
    this._data = data;
  }
  get textContent() { return this._data; }
  set textContent(val) { this._data = val; }
  splitText(offset) {
    const second = new DOMTextNode(this._data.substring(offset));
    this._data = this._data.substring(0, offset);
    if (this.parentNode) {
      const sibs = this.parentNode._children;
      const idx = sibs.indexOf(this);
      second.parentNode = this.parentNode;
      second.parentElement = this.parentElement;
      sibs.splice(idx + 1, 0, second);
    }
    return second;
  }
}

class DOMElement extends DOMNode {
  constructor(tag) {
    super(NODE_ELEMENT);
    this.tagName = tag.toUpperCase();
    this._className = '';
    this._attributes = {};
    this._listeners = {};
    this.id = '';
    this.innerHTML = '';
    this.title = '';
    this._classList = new Set();
  }
  get className() { return this._className; }
  set className(val) {
    this._className = val;
    this._classList.clear();
    if (val) val.split(/\s+/).filter(Boolean).forEach(c => this._classList.add(c));
  }
  get classList() {
    const self = this;
    return {
      add(...cls) { cls.forEach(c => self._classList.add(c)); self._className = Array.from(self._classList).join(' '); },
      remove(...cls) { cls.forEach(c => self._classList.delete(c)); self._className = Array.from(self._classList).join(' '); },
      contains(c) { return self._classList.has(c); },
      toggle(c) {
        if (self._classList.has(c)) self._classList.delete(c);
        else self._classList.add(c);
        self._className = Array.from(self._classList).join(' ');
      },
    };
  }
  setAttribute(name, value) { this._attributes[name] = String(value); }
  getAttribute(name) { return this._attributes[name] ?? null; }
  appendChild(child) { return this._appendChild(child); }
  insertBefore(newChild, refChild) { return this._insertBefore(newChild, refChild); }
  removeChild(child) { return this._removeChild(child); }
  cloneNode(deep) {
    const clone = new DOMElement(this.tagName);
    clone.className = this.className;
    clone.id = this.id;
    Object.assign(clone._attributes, this._attributes);
    if (deep) {
      for (const child of this._children) {
        clone.appendChild(child.cloneNode ? child.cloneNode(true) : new DOMTextNode(child._data));
      }
    }
    return clone;
  }
  contains(node) {
    if (node === this) return true;
    for (const child of this._children) {
      if (child === node) return true;
      if (child.nodeType === NODE_ELEMENT && child.contains(node)) return true;
    }
    return false;
  }
  closest(selector) {
    // Minimal: supports tagName only (e.g. 'blockquote')
    let el = this;
    while (el) {
      if (el.nodeType === NODE_ELEMENT && el.tagName === selector.toUpperCase()) return el;
      el = el.parentNode;
    }
    return null;
  }
  querySelector(selector) {
    const all = this.querySelectorAll(selector);
    return all[0] || null;
  }
  querySelectorAll(selector) {
    const results = [];
    const match = (el) => {
      if (_matchSelector(el, selector)) results.push(el);
      for (const c of el._children) {
        if (c.nodeType === NODE_ELEMENT) match(c);
      }
    };
    for (const c of this._children) {
      if (c.nodeType === NODE_ELEMENT) match(c);
    }
    return results;
  }
  addEventListener(evt, fn) {
    if (!this._listeners[evt]) this._listeners[evt] = [];
    this._listeners[evt].push(fn);
  }
  get children() { return this._children.filter(c => c.nodeType === NODE_ELEMENT); }
}

function _matchSelector(el, selector) {
  if (el.nodeType !== NODE_ELEMENT) return false;
  // ".classname"
  if (selector.startsWith('.')) {
    return el._classList.has(selector.slice(1));
  }
  // "tagname"
  if (/^[a-zA-Z]+$/.test(selector)) {
    return el.tagName === selector.toUpperCase();
  }
  return false;
}

// ---------------------------------------------------------------------------
// Build sandbox with DOM mocks and load both modules
// ---------------------------------------------------------------------------

function buildSandbox(bodyChildren) {
  const body = new DOMElement('body');
  for (const child of bodyChildren) body.appendChild(child);

  const elementsById = {};
  const registerIds = (el) => {
    if (el.id) elementsById[el.id] = el;
    for (const c of el._children) {
      if (c.nodeType === NODE_ELEMENT) registerIds(c);
    }
  };
  registerIds(body);

  const doc = {
    readyState: 'loading',
    body,
    location: { href: 'imap://test.example.com:993/fetch%3EUID%3E/INBOX%3E12345' },
    getElementById: (id) => elementsById[id] || null,
    createElement: (tag) => new DOMElement(tag),
    createTreeWalker: () => null, // Guard check only — not actually called
    addEventListener: () => {},
    documentElement: { scrollTop: 0 },
  };

  const win = {
    getComputedStyle: (el) => ({
      display: el.tagName === 'SPAN' || el.tagName === 'A' ? 'inline' : 'block',
    }),
    requestAnimationFrame: (cb) => cb(),
    __tmDisplayGateFlags: {},
    __tmDisplayGateCycleId: 0,
  };

  return {
    globalThis: {},
    document: doc,
    window: win,
    console,
    Node: { ELEMENT_NODE: NODE_ELEMENT, TEXT_NODE: NODE_TEXT },
  };
}

function loadModules(sandbox) {
  const qdCode = readFileSync(resolve(__dirname, '../agent/modules/quoteAndSignature.js'), 'utf8');
  runInNewContext(qdCode, sandbox);

  const mbCode = readFileSync(resolve(__dirname, '../theme/modules/messageBubble.js'), 'utf8');
  runInNewContext(mbCode, sandbox);

  return sandbox.globalThis.TabMailMessageBubble;
}

// ---------------------------------------------------------------------------
// Helper: build a plain-text email <pre> with reply + original message
// ---------------------------------------------------------------------------

function buildPlainTextEmail({ replyText, quotedText }) {
  const wrapper = new DOMElement('div');
  wrapper.id = 'tm-message-bubble-wrapper';

  const mozTextPlain = new DOMElement('div');
  mozTextPlain.className = 'moz-text-plain';

  const pre = new DOMElement('pre');
  pre.className = 'moz-quote-pre';
  const textNode = new DOMTextNode(replyText + quotedText);
  pre.appendChild(textNode);

  mozTextPlain.appendChild(pre);
  wrapper.appendChild(mozTextPlain);

  return { wrapper, mozTextPlain, pre, textNode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('messageBubble <pre> split for plain-text quote collapse', () => {
  it('splits <pre> when reply and -----Original Message----- are in same node', () => {
    const replyText = 'Hi there,\n\nI have attached the document you requested. Please review and let me know if anything else is needed.\n\nWith thanks,\nSender\n\n\n\n';
    const quotedText = '-----Original Message-----\nFrom: Recipient <recipient@example.com>\nSent: March 31, 2026 4:40 PM\nTo: Sender <sender@example.com>\nSubject: Re: Document Request\n\nPlease send the document.\n';

    const { wrapper } = buildPlainTextEmail({ replyText, quotedText });
    const sandbox = buildSandbox([wrapper]);
    const MB = loadModules(sandbox);

    MB.setupCollapsibleQuotes();

    // The quote wrapper should exist
    const quoteWrapper = wrapper.querySelector('.tm-quote-wrapper');
    expect(quoteWrapper).not.toBeNull();

    // The reply text should NOT be inside the collapsed quote wrapper
    const quoteContent = quoteWrapper.querySelector('.tm-quote-content');
    expect(quoteContent).not.toBeNull();
    const collapsedText = quoteContent.textContent;

    // The collapsed region should contain the "-----Original Message-----" boundary
    expect(collapsedText).toContain('-----Original Message-----');

    // The reply text should NOT be in the collapsed region
    expect(collapsedText).not.toContain('I have attached the document');
    expect(collapsedText).not.toContain('With thanks');

    // The reply text should still be visible (in the first <pre>)
    // Walk the wrapper's children to find text not in the quote wrapper
    let visibleText = '';
    for (const child of wrapper._children) {
      if (child.nodeType === NODE_ELEMENT) {
        // Recurse but skip the quote wrapper
        const collectVisible = (el) => {
          if (el._classList && el._classList.has('tm-quote-wrapper')) return;
          for (const c of el._children) {
            if (c.nodeType === NODE_TEXT) visibleText += c._data;
            else if (c.nodeType === NODE_ELEMENT) collectVisible(c);
          }
        };
        collectVisible(child);
      }
    }
    expect(visibleText).toContain('I have attached the document');
    expect(visibleText).toContain('With thanks');
  });

  it('does NOT split when boundary is at the start of <pre> (offset 0)', () => {
    // The entire <pre> is a quote — no reply text before the boundary
    const quotedText = '-----Original Message-----\nFrom: Someone <someone@example.com>\nSent: Today\n\nOriginal content.\n';

    const { wrapper } = buildPlainTextEmail({ replyText: '', quotedText });
    const sandbox = buildSandbox([wrapper]);
    const MB = loadModules(sandbox);

    MB.setupCollapsibleQuotes();

    const quoteWrapper = wrapper.querySelector('.tm-quote-wrapper');
    expect(quoteWrapper).not.toBeNull();

    // Everything should be inside the collapsed region
    const quoteContent = quoteWrapper.querySelector('.tm-quote-content');
    expect(quoteContent.textContent).toContain('-----Original Message-----');
  });

  it('does NOT split when reply text is too short (< 10 chars trimmed)', () => {
    const replyText = 'OK\n\n';
    const quotedText = '-----Original Message-----\nFrom: Someone <someone@example.com>\n';

    const { wrapper } = buildPlainTextEmail({ replyText, quotedText });
    const sandbox = buildSandbox([wrapper]);
    const MB = loadModules(sandbox);

    MB.setupCollapsibleQuotes();

    const quoteWrapper = wrapper.querySelector('.tm-quote-wrapper');
    expect(quoteWrapper).not.toBeNull();

    // With only "OK" before the boundary (2 chars trimmed < 10), no split occurs.
    // The moz-text-plain div is the quoteStart (walked up from <pre>).
    const quoteContent = quoteWrapper.querySelector('.tm-quote-content');
    expect(quoteContent.textContent).toContain('OK');
    expect(quoteContent.textContent).toContain('-----Original Message-----');
  });

  it('handles <pre> with mixed text nodes and link elements after boundary', () => {
    // The <pre> has a text node, then after the boundary there are <a> link elements
    const wrapper = new DOMElement('div');
    wrapper.id = 'tm-message-bubble-wrapper';

    const mozTextPlain = new DOMElement('div');
    mozTextPlain.className = 'moz-text-plain';

    const pre = new DOMElement('pre');
    pre.className = 'moz-quote-pre';

    // Text before boundary + boundary start
    const text1 = new DOMTextNode(
      'Hello,\n\nPlease find the attached files as discussed in our meeting.\n\nBest regards,\nAlice\n\n\n\n-----Original Message-----\nFrom: Bob '
    );
    pre.appendChild(text1);

    // An <a> element (email link — typical in Thunderbird plain-text rendering)
    const link = new DOMElement('a');
    link.className = 'moz-txt-link-rfc2396E';
    link.appendChild(new DOMTextNode('<bob@example.com>'));
    pre.appendChild(link);

    // More text after the link
    const text2 = new DOMTextNode('\nSent: March 30, 2026\nSubject: Meeting notes\n\nHere are the notes.\n');
    pre.appendChild(text2);

    mozTextPlain.appendChild(pre);
    wrapper.appendChild(mozTextPlain);

    const sandbox = buildSandbox([wrapper]);
    const MB = loadModules(sandbox);

    MB.setupCollapsibleQuotes();

    const quoteWrapper = wrapper.querySelector('.tm-quote-wrapper');
    expect(quoteWrapper).not.toBeNull();

    const quoteContent = quoteWrapper.querySelector('.tm-quote-content');
    const collapsedText = quoteContent.textContent;

    // The collapsed region should have the quote content
    expect(collapsedText).toContain('-----Original Message-----');
    expect(collapsedText).toContain('<bob@example.com>');
    expect(collapsedText).toContain('Here are the notes');

    // The reply text should NOT be collapsed
    expect(collapsedText).not.toContain('Please find the attached files');
    expect(collapsedText).not.toContain('Best regards');
  });

  it('narrows quoteStart for moz-text-flowed div with "On ... wrote:" attribution', () => {
    // moz-text-flowed emails have reply text + attribution as sibling nodes
    // inside a single <div>, with <br> elements between them.
    const wrapper = new DOMElement('div');
    wrapper.id = 'tm-message-bubble-wrapper';

    const mozTextFlowed = new DOMElement('div');
    mozTextFlowed.className = 'moz-text-flowed';

    // Reply content as text + br nodes (matches Thunderbird flowed rendering)
    mozTextFlowed.appendChild(new DOMTextNode('Hello,'));
    mozTextFlowed.appendChild(new DOMElement('br'));
    mozTextFlowed.appendChild(new DOMElement('br'));
    mozTextFlowed.appendChild(new DOMTextNode('Please find the signed acceptance letter attached.'));
    mozTextFlowed.appendChild(new DOMElement('br'));
    mozTextFlowed.appendChild(new DOMElement('br'));
    mozTextFlowed.appendChild(new DOMTextNode('Cheers,'));
    mozTextFlowed.appendChild(new DOMElement('br'));
    mozTextFlowed.appendChild(new DOMTextNode('Sender'));
    mozTextFlowed.appendChild(new DOMElement('br'));
    mozTextFlowed.appendChild(new DOMElement('br'));

    // Attribution line — this is where the quote boundary should be detected
    mozTextFlowed.appendChild(new DOMTextNode('On 3/27/26 07:42, John Smith wrote:'));
    mozTextFlowed.appendChild(new DOMElement('br'));

    // Blockquote with quoted content
    const bq = new DOMElement('blockquote');
    bq.appendChild(new DOMTextNode('Original message content here.'));
    mozTextFlowed.appendChild(bq);

    wrapper.appendChild(mozTextFlowed);

    const sandbox = buildSandbox([wrapper]);
    const MB = loadModules(sandbox);

    MB.setupCollapsibleQuotes();

    const quoteWrapper = wrapper.querySelector('.tm-quote-wrapper');
    expect(quoteWrapper).not.toBeNull();

    const quoteContent = quoteWrapper.querySelector('.tm-quote-content');
    const collapsedText = quoteContent.textContent;

    // The collapsed region should contain the attribution + quoted content
    expect(collapsedText).toContain('On 3/27/26 07:42, John Smith wrote:');
    expect(collapsedText).toContain('Original message content');

    // The reply text should NOT be collapsed
    expect(collapsedText).not.toContain('Please find the signed acceptance letter');
    expect(collapsedText).not.toContain('Cheers');
  });
});
