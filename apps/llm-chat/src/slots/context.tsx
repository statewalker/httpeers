import type { KeyedSlotDeclaration, Slots } from "@statewalker/shared-slots";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";

const SlotsContext = createContext<Slots | null>(null);

/** Thrown by `useSlots`/`useSlot` when called outside a `SlotsProvider`. */
export class MissingSlotsProviderError extends Error {
  constructor() {
    super("useSlots/useSlot must be called within a SlotsProvider");
    this.name = "MissingSlotsProviderError";
  }
}

export function SlotsProvider(props: { slots: Slots; children: ReactNode }) {
  return <SlotsContext.Provider value={props.slots}>{props.children}</SlotsContext.Provider>;
}

export function useSlots(): Slots {
  const slots = useContext(SlotsContext);
  if (!slots) throw new MissingSlotsProviderError();
  return slots;
}

/**
 * Subscribe to a keyed slot's contributions as an ordered array, re-rendering
 * whenever the bus notifies (including a contribution registered after this
 * component mounted, or one dropped by its disposer). Built on
 * `useSyncExternalStore` over `Slots#observe`/`Slots#getSnapshot` rather than
 * `useState` + an effect, so a registration that lands mid-render (e.g. from
 * a sibling's render) is never missed the way an effect-based subscription
 * would miss it.
 *
 * `Slots#getSnapshot` for a keyed declaration already returns a
 * referentially-stable `ReadonlyMap` between mutations (the bus caches it
 * internally and only replaces the reference on the next `register`/dispose).
 * But `useSyncExternalStore`'s contract is about the value *this hook*
 * returns, which is `T[]`, not the Map — and `Array.from(map.values())`
 * allocates a fresh array on every call. Returning a fresh array from
 * `getSnapshot` would make React believe the store changed on every render
 * and re-render forever. So we cache the last Map -> array we derived and
 * only recompute when the Map reference itself has changed, i.e. only when
 * the bus actually notified us.
 */
export function useSlot<T>(declaration: KeyedSlotDeclaration<T>): T[] {
  const slots = useSlots();

  const cache = useRef<{ map: ReadonlyMap<string, T>; values: T[] } | null>(null);

  const getSnapshot = useCallback(() => {
    const map = slots.getSnapshot(declaration);
    if (cache.current === null || cache.current.map !== map) {
      cache.current = { map, values: Array.from(map.values()) };
    }
    return cache.current.values;
  }, [slots, declaration]);

  const subscribe = useCallback(
    (onStoreChange: () => void) => slots.observe(declaration, onStoreChange),
    [slots, declaration],
  );

  return useSyncExternalStore(subscribe, getSnapshot);
}
