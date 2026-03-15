// promptsUtils.test.js — Tests for prompts/modules/utils.js
//
// Pure utility functions: deepClone, flashButton, flashBorder, showStatus, autoGrowTextarea

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../agent/modules/utils.js', () => ({
  log: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Import module under test
// ---------------------------------------------------------------------------

const { deepClone, autoGrowTextarea, showStatus, flashButton, flashBorder } = await import('../prompts/modules/utils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deepClone', () => {
  it('clones a simple object', () => {
    const obj = { a: 1, b: 'hello' };
    const cloned = deepClone(obj);
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
  });

  it('clones nested objects', () => {
    const obj = { a: { b: { c: 3 } } };
    const cloned = deepClone(obj);
    expect(cloned.a.b.c).toBe(3);
    cloned.a.b.c = 99;
    expect(obj.a.b.c).toBe(3); // original unchanged
  });

  it('clones arrays', () => {
    const arr = [1, 2, [3, 4]];
    const cloned = deepClone(arr);
    expect(cloned).toEqual(arr);
    cloned[2][0] = 99;
    expect(arr[2][0]).toBe(3);
  });

  it('clones mixed objects and arrays', () => {
    const obj = { items: [{ name: 'a' }, { name: 'b' }] };
    const cloned = deepClone(obj);
    expect(cloned.items).toHaveLength(2);
    expect(cloned.items[0].name).toBe('a');
    cloned.items[0].name = 'changed';
    expect(obj.items[0].name).toBe('a');
  });

  it('handles null', () => {
    expect(deepClone(null)).toBe(null);
  });

  it('handles empty object', () => {
    expect(deepClone({})).toEqual({});
  });

  it('handles empty array', () => {
    expect(deepClone([])).toEqual([]);
  });

  it('handles primitive values', () => {
    expect(deepClone(42)).toBe(42);
    expect(deepClone('hello')).toBe('hello');
    expect(deepClone(true)).toBe(true);
  });

  it('does not preserve functions (JSON limitation)', () => {
    const obj = { fn: () => 42, value: 1 };
    const cloned = deepClone(obj);
    expect(cloned.fn).toBeUndefined();
    expect(cloned.value).toBe(1);
  });

  it('does not preserve Date objects (becomes string)', () => {
    const obj = { date: new Date('2026-01-01') };
    const cloned = deepClone(obj);
    expect(typeof cloned.date).toBe('string');
  });
});

describe('autoGrowTextarea', () => {
  it('sets height to auto then scrollHeight + 2', () => {
    const textarea = {
      style: { height: '100px' },
      scrollHeight: 50,
    };
    autoGrowTextarea(textarea);
    expect(textarea.style.height).toBe('52px');
  });

  it('works with zero scrollHeight', () => {
    const textarea = {
      style: { height: '50px' },
      scrollHeight: 0,
    };
    autoGrowTextarea(textarea);
    expect(textarea.style.height).toBe('2px');
  });
});

describe('showStatus', () => {
  let statusEl;

  beforeEach(() => {
    statusEl = {
      textContent: '',
      className: '',
      style: { display: 'none' },
    };
    globalThis.document = {
      getElementById: vi.fn((id) => {
        if (id === 'status-message') return statusEl;
        return null;
      }),
    };
  });

  it('shows success message', () => {
    showStatus('Saved!');
    expect(statusEl.textContent).toBe('Saved!');
    expect(statusEl.className).toBe('success');
    expect(statusEl.style.display).toBe('block');
  });

  it('shows error message', () => {
    showStatus('Error occurred', true);
    expect(statusEl.textContent).toBe('Error occurred');
    expect(statusEl.className).toBe('error');
  });

  it('handles missing status element', () => {
    globalThis.document.getElementById = vi.fn(() => null);
    expect(() => showStatus('test')).not.toThrow();
  });
});

describe('flashButton', () => {
  let button;

  beforeEach(() => {
    button = {
      style: { background: '', border: '' },
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    };
  });

  it('adds red flash class', () => {
    flashButton(button, 'red');
    expect(button.classList.add).toHaveBeenCalledWith('btn-flash-red');
  });

  it('adds blue flash class', () => {
    flashButton(button, 'blue');
    expect(button.classList.add).toHaveBeenCalledWith('btn-flash-blue');
  });

  it('adds green flash class', () => {
    flashButton(button, 'green');
    expect(button.classList.add).toHaveBeenCalledWith('btn-flash-green');
  });

  it('defaults to blue flash class', () => {
    flashButton(button);
    expect(button.classList.add).toHaveBeenCalledWith('btn-flash-blue');
  });

  it('does not throw for null button', () => {
    expect(() => flashButton(null)).not.toThrow();
  });
});

describe('flashBorder', () => {
  let element;

  beforeEach(() => {
    element = {
      style: { outline: '', outlineOffset: '' },
      classList: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    };
  });

  it('adds red border flash class', () => {
    flashBorder(element, 'red');
    expect(element.classList.add).toHaveBeenCalledWith('border-flash-red');
  });

  it('adds green border flash class', () => {
    flashBorder(element, 'green');
    expect(element.classList.add).toHaveBeenCalledWith('border-flash-green');
  });

  it('defaults to blue border flash class', () => {
    flashBorder(element);
    expect(element.classList.add).toHaveBeenCalledWith('border-flash-blue');
  });

  it('also defaults to blue for unknown color', () => {
    flashBorder(element, 'purple');
    expect(element.classList.add).toHaveBeenCalledWith('border-flash-blue');
  });

  it('does not throw for null element', () => {
    expect(() => flashBorder(null)).not.toThrow();
  });
});
