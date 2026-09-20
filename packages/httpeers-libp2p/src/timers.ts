/**
 * The timer seam: the four calls anything long-lived in this package schedules
 * with, behind an interface instead of the global functions.
 *
 * WHY, AND IT IS NOT TESTABILITY. A browser throttles `setTimeout` and
 * `setInterval` in a background tab -- to once a minute, and on some engines
 * far less -- and a hub running in a tab is a hub whose relay reservation is
 * renewed on the browser's schedule rather than on the relay's. The fix is
 * `worker-timers`, which schedules from a Web Worker and is not throttled; the
 * fix is NOT to shorten the interval, which changes nothing about what the
 * browser does to it. That wiring is deliberately not here yet (the Node hub is
 * what runs today); this seam is what makes it a one-line change later:
 *
 *   import { clearInterval, clearTimeout, setInterval, setTimeout } from "worker-timers";
 *   const timers: Timers = { setTimeout, clearTimeout, setInterval, clearInterval };
 *
 * Tests get the seam for free, and that is the cheaper of the two reasons.
 *
 * `TimerHandle` IS `unknown` ON PURPOSE. Node's timers return an object,
 * browsers return a number, `worker-timers` returns a number of its own that
 * only its own `clearTimeout` understands. An implementation must therefore
 * only ever hand its OWN handles back to its OWN clear functions -- which is
 * exactly what an opaque type states and a `number` alias would quietly
 * permit callers to violate.
 */

/** A handle from one `Timers` implementation, meaningful only to that same one. */
export type TimerHandle = unknown;

export interface Timers {
  setTimeout(handler: () => void, delayMs: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(handler: () => void, delayMs: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

/** The global timers, which is what everything uses unless it is told otherwise. */
export const globalTimers: Timers = {
  setTimeout: (handler, delayMs) => setTimeout(handler, delayMs),
  clearTimeout: (handle) => {
    if (handle !== undefined) clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
  setInterval: (handler, delayMs) => setInterval(handler, delayMs),
  clearInterval: (handle) => {
    if (handle !== undefined) clearInterval(handle as ReturnType<typeof setInterval>);
  },
};
