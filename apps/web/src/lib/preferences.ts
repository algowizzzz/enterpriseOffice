/**
 * Theme and text size: preferences about the screen somebody is reading on,
 * not about a document's own content, so they live outside any one page and
 * apply everywhere at once, the way the editor's own zoom does for the page.
 *
 * The document itself (`.page` and everything inside it, in
 * `apps/web/src/styles/app.css`) is deliberately never themed by either of
 * these: it is meant to look like paper, in light mode or dark, because that
 * is what it will be when it is printed or exported. Theming it would mean
 * the screen stops matching what Word opens, which is the one thing this
 * project exists to get right.
 */

export type Theme = 'light' | 'dark';

const THEME_KEY = 'docforge-theme';
const SCALE_KEY = 'docforge-ui-scale';

const isTheme = (value: string | null): value is Theme => value === 'light' || value === 'dark';

export function getTheme(): Theme {
  const stored = window.localStorage.getItem(THEME_KEY);
  if (isTheme(stored)) return stored;
  // Nobody has chosen yet: start from what the operating system says. A
  // person who already turned dark mode on everywhere should not have to
  // turn it on again here. `matchMedia` does not exist in every test
  // environment, so both the call and the read of its result are guarded.
  return window.matchMedia?.('(prefers-color-scheme: dark)')?.matches ? 'dark' : 'light';
}

export function getUiScale(): number {
  const stored = Number(window.localStorage.getItem(SCALE_KEY));
  return Number.isFinite(stored) && stored >= 85 && stored <= 150 ? stored : 100;
}

function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
}

function applyUiScale(scale: number): void {
  document.documentElement.style.setProperty('--ui-scale', String(scale / 100));
}

export function setTheme(theme: Theme): void {
  window.localStorage.setItem(THEME_KEY, theme);
  applyTheme(theme);
}

export function setUiScale(scale: number): void {
  window.localStorage.setItem(SCALE_KEY, String(scale));
  applyUiScale(scale);
}

/**
 * Applied once, as early as the module graph allows (imported at the top of
 * `main.tsx`, before the first render), so the interface never flashes the
 * wrong theme or the wrong size before this runs.
 */
export function applyStoredPreferences(): void {
  applyTheme(getTheme());
  applyUiScale(getUiScale());
}
