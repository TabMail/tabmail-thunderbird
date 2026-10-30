/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

// promptsUtils.test.js — Tests for prompts/modules/utils.js
//
// Pure utility functions: flashButton, flashBorder, showStatus, autoGrowTextarea

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

const { autoGrowTextarea, showStatus, flashButton, flashBorder } = await import('../prompts/modules/utils.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

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
