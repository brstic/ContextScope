import { useCallback, useSyncExternalStore } from 'react';

export type Theme = 'dark' | 'light';
const KEY = 'cs.theme';

const read = (): Theme => {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light') return v;
  } catch {
    /* storage unavailable */
  }
  if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) {
    return 'light';
  }
  return 'dark';
};

let current: Theme = typeof document === 'undefined' ? 'dark' : read();
const listeners = new Set<() => void>();

export const applyTheme = (t: Theme): void => {
  current = t;
  const root = document.documentElement;
  root.classList.toggle('dark', t === 'dark');
  root.classList.toggle('light', t === 'light');
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
  listeners.forEach((l) => l());
};

export const initTheme = (): void => {
  const t = read();
  current = t;
  const root = document.documentElement;
  root.classList.toggle('dark', t === 'dark');
  root.classList.toggle('light', t === 'light');
};

export const useTheme = (): [Theme, (t: Theme) => void, () => void] => {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
    () => 'dark' as Theme,
  );
  const toggle = useCallback(() => applyTheme(current === 'dark' ? 'light' : 'dark'), []);
  return [theme, applyTheme, toggle];
};
