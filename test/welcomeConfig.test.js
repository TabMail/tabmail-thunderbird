// welcomeConfig.test.js — Tests for welcome/welcomeConfig.js
//
// Pure functions: getFlattenedSteps, getTotalSteps, getCategoryForStep, getCategories, getPageUrl

import { describe, it, expect } from 'vitest';

const {
  WELCOME_CONFIG,
  getFlattenedSteps,
  getTotalSteps,
  getCategoryForStep,
  getCategories,
  getPageUrl,
} = await import('../welcome/welcomeConfig.js');

// ---------------------------------------------------------------------------
// Tests for WELCOME_CONFIG
// ---------------------------------------------------------------------------

describe('WELCOME_CONFIG', () => {
  it('has window dimensions', () => {
    expect(WELCOME_CONFIG.window).toBeDefined();
    expect(typeof WELCOME_CONFIG.window.defaultWidth).toBe('number');
    expect(typeof WELCOME_CONFIG.window.defaultHeight).toBe('number');
  });

  it('has transition duration', () => {
    expect(typeof WELCOME_CONFIG.transitionDuration).toBe('number');
    expect(WELCOME_CONFIG.transitionDuration).toBeGreaterThan(0);
  });

  it('has pages directory', () => {
    expect(typeof WELCOME_CONFIG.pagesDir).toBe('string');
  });

  it('has categories array', () => {
    expect(Array.isArray(WELCOME_CONFIG.categories)).toBe(true);
    expect(WELCOME_CONFIG.categories.length).toBeGreaterThan(0);
  });

  it('each category has id, label, and steps', () => {
    for (const cat of WELCOME_CONFIG.categories) {
      expect(typeof cat.id).toBe('string');
      expect(typeof cat.label).toBe('string');
      expect(Array.isArray(cat.steps)).toBe(true);
      expect(cat.steps.length).toBeGreaterThan(0);
    }
  });

  it('each step has id, title, and page', () => {
    for (const cat of WELCOME_CONFIG.categories) {
      for (const step of cat.steps) {
        expect(typeof step.id).toBe('string');
        expect(typeof step.title).toBe('string');
        expect(typeof step.page).toBe('string');
        expect(step.page.endsWith('.html')).toBe(true);
      }
    }
  });

  it('has storageKey', () => {
    expect(typeof WELCOME_CONFIG.storageKey).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// Tests for getFlattenedSteps
// ---------------------------------------------------------------------------

describe('getFlattenedSteps', () => {
  it('returns an array', () => {
    const steps = getFlattenedSteps();
    expect(Array.isArray(steps)).toBe(true);
  });

  it('returns all steps across all categories', () => {
    const steps = getFlattenedSteps();
    const expectedTotal = WELCOME_CONFIG.categories.reduce(
      (sum, cat) => sum + cat.steps.length,
      0
    );
    expect(steps.length).toBe(expectedTotal);
  });

  it('each entry has required fields', () => {
    const steps = getFlattenedSteps();
    for (const step of steps) {
      expect(typeof step.stepId).toBe('string');
      expect(typeof step.title).toBe('string');
      expect(typeof step.page).toBe('string');
      expect(typeof step.categoryId).toBe('string');
      expect(typeof step.categoryLabel).toBe('string');
      expect(typeof step.stepIndex).toBe('number');
      expect(typeof step.categoryIndex).toBe('number');
    }
  });

  it('step indices are sequential starting from 0', () => {
    const steps = getFlattenedSteps();
    for (let i = 0; i < steps.length; i++) {
      expect(steps[i].stepIndex).toBe(i);
    }
  });

  it('first step is the welcome step', () => {
    const steps = getFlattenedSteps();
    expect(steps[0].stepId).toBe('welcome');
    expect(steps[0].categoryId).toBe('welcome');
  });
});

// ---------------------------------------------------------------------------
// Tests for getTotalSteps
// ---------------------------------------------------------------------------

describe('getTotalSteps', () => {
  it('returns a positive number', () => {
    const total = getTotalSteps();
    expect(total).toBeGreaterThan(0);
  });

  it('matches getFlattenedSteps length', () => {
    expect(getTotalSteps()).toBe(getFlattenedSteps().length);
  });
});

// ---------------------------------------------------------------------------
// Tests for getCategoryForStep
// ---------------------------------------------------------------------------

describe('getCategoryForStep', () => {
  it('returns 0 for the first step', () => {
    expect(getCategoryForStep(0)).toBe(0);
  });

  it('returns -1 for out-of-range step index', () => {
    expect(getCategoryForStep(-1)).toBe(-1);
    expect(getCategoryForStep(9999)).toBe(-1);
  });

  it('returns correct category index for steps in different categories', () => {
    const steps = getFlattenedSteps();
    // The first step should be in category 0
    expect(getCategoryForStep(steps[0].stepIndex)).toBe(0);

    // Find the first step in a different category
    const secondCatStep = steps.find((s) => s.categoryIndex > 0);
    if (secondCatStep) {
      expect(getCategoryForStep(secondCatStep.stepIndex)).toBe(secondCatStep.categoryIndex);
    }
  });
});

// ---------------------------------------------------------------------------
// Tests for getCategories
// ---------------------------------------------------------------------------

describe('getCategories', () => {
  it('returns the categories array', () => {
    const cats = getCategories();
    expect(cats).toBe(WELCOME_CONFIG.categories);
  });

  it('has at least 2 categories', () => {
    expect(getCategories().length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// Tests for getPageUrl
// ---------------------------------------------------------------------------

describe('getPageUrl', () => {
  it('returns page URL for valid step index', () => {
    const url = getPageUrl(0);
    expect(url).not.toBe(null);
    expect(url).toContain(WELCOME_CONFIG.pagesDir);
    expect(url).toContain('.html');
  });

  it('returns null for negative step index', () => {
    expect(getPageUrl(-1)).toBe(null);
  });

  it('returns null for out-of-range step index', () => {
    expect(getPageUrl(9999)).toBe(null);
  });

  it('returns correct URL format', () => {
    const steps = getFlattenedSteps();
    for (const step of steps) {
      const url = getPageUrl(step.stepIndex);
      expect(url).toBe(`${WELCOME_CONFIG.pagesDir}/${step.page}`);
    }
  });
});
