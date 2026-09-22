import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyStoredPreferences, getTheme, getUiScale, setTheme, setUiScale } from '../src/lib/preferences';

describe('preferences', () => {
  const originalMatchMedia = window.matchMedia;

  beforeEach(() => {
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.style.removeProperty('--ui-scale');
  });

  afterEach(() => {
    window.matchMedia = originalMatchMedia;
  });

  it('reads the system preference when nobody has chosen a theme yet', () => {
    window.matchMedia = (query: string) => ({ matches: query.includes('dark') }) as MediaQueryList;
    expect(getTheme()).toBe('dark');
  });

  it('defaults to light without throwing when matchMedia does not exist', () => {
    // Regression: `window.matchMedia?.(query).matches` throws when
    // `matchMedia` is undefined, because the optional call still leaves a
    // plain property read on its result. Not every environment has it.
    // @ts-expect-error -- simulating an environment without matchMedia
    delete window.matchMedia;
    expect(() => getTheme()).not.toThrow();
    expect(getTheme()).toBe('light');
  });

  it('remembers an explicit choice over the system preference', () => {
    window.matchMedia = (query: string) => ({ matches: query.includes('dark') }) as MediaQueryList;
    setTheme('light');
    expect(getTheme()).toBe('light');
  });

  it('applies the theme to the document element', () => {
    setTheme('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    setTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });

  it('defaults the text size to 100 and clamps out-of-range stored values', () => {
    expect(getUiScale()).toBe(100);
    window.localStorage.setItem('docforge-ui-scale', '9999');
    expect(getUiScale()).toBe(100);
  });

  it('sets --ui-scale as a multiplier, not a percentage', () => {
    setUiScale(125);
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('1.25');
  });

  it('applies both stored preferences at once, the way main.tsx calls it before the first render', () => {
    window.localStorage.setItem('docforge-theme', 'dark');
    window.localStorage.setItem('docforge-ui-scale', '90');
    applyStoredPreferences();
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--ui-scale')).toBe('0.9');
  });
});
