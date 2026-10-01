// A minimal typed store: one state object, replaced (never mutated) on every change.

export interface Store<S> {
  get(): Readonly<S>;
  set(patch: Partial<S>): void;
  /** Called after every change with the new and the previous state; returns an unsubscribe function. */
  subscribe(listener: (state: Readonly<S>, prev: Readonly<S>) => void): () => void;
}

export function createStore<S extends object>(initial: S, normalize: (s: S) => S = s => s): Store<S> {
  let state = normalize(initial);
  const listeners = new Set<(state: Readonly<S>, prev: Readonly<S>) => void>();
  return {
    get: () => state,
    set(patch) {
      const prev = state;
      const next = normalize({ ...state, ...patch });
      const changed = (Object.keys(next) as (keyof S)[]).some(k => next[k] !== prev[k]);
      if (!changed) return;
      state = next;
      for (const listener of listeners) listener(state, prev);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
