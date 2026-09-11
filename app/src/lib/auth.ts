import { useSyncExternalStore } from 'react';

/**
 * Bearer-token storage plus a tiny external store for the "needs auth" flag.
 * The fetch wrapper flips the flag on any 401; the root layout watches it and
 * swaps in the token-entry screen.
 */

export const TOKEN_STORAGE_KEY = 'mcp-zeromem-token';

type Listener = () => void;

let needsAuth = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function getToken(): string | null {
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  if (needsAuth) {
    needsAuth = false;
    emit();
  }
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

/** Called by the API client whenever a request comes back 401. */
export function requireAuth(): void {
  if (!needsAuth) {
    needsAuth = true;
    emit();
  }
}

export function getNeedsAuth(): boolean {
  return needsAuth;
}

export function subscribeNeedsAuth(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useNeedsAuth(): boolean {
  return useSyncExternalStore(subscribeNeedsAuth, getNeedsAuth);
}
