/**
 * Light/dark theme. index.html applies the initial class before first paint
 * (stored preference, else the OS preference); this module owns changes after
 * that. Toggling stores an explicit preference; clearing it would fall back to
 * the OS on next load.
 */

export const THEME_STORAGE_KEY = 'mcp-zeromem-theme';

export function isDark(): boolean {
  return document.documentElement.classList.contains('dark');
}

export function setDark(dark: boolean): void {
  document.documentElement.classList.toggle('dark', dark);
  window.localStorage.setItem(THEME_STORAGE_KEY, dark ? 'dark' : 'light');
}
