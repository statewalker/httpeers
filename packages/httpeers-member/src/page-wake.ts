/**
 * The page events that mean "the relay link may have died while nothing was
 * watching, and may be reachable again now" -- turned into one callback.
 */

/** The parts of `window` this reads. */
export type WakeWindow = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** The parts of `document` this reads. */
export type WakeDocument = Pick<EventTarget, "addEventListener" | "removeEventListener"> & {
  readonly visibilityState: string;
};

export interface WatchPageWakeInit {
  win?: WakeWindow;
  doc?: WakeDocument;
}

/**
 * The two browser globals this file names, declared LOCALLY rather than by
 * adding "dom" to the package's `lib`.
 *
 * Same technique and same reason as `httpeers-libp2p/src/browser.ts`'s
 * `indexedDB`: one browser-only module must not put `window` and `document`
 * in scope for every Node module beside it, where naming them is a bug the
 * compiler should catch. The types are the two `Pick`s above, so the
 * declaration also states exactly how much of each global is used.
 */
declare const window: WakeWindow;
declare const document: WakeDocument;

/**
 * Call `onWake` whenever the page comes back; returns the unsubscribe.
 *
 * Why these events, and not a timer: a suspended page's timers are
 * throttled or stopped, so the relay supervisor's own backoff may not fire
 * for minutes after the page is usable again. See
 * `tests/browser-page-wake.test.ts` for what each event means.
 */
export function watchPageWake(onWake: () => void, init: WatchPageWakeInit = {}): () => void {
  const win = init.win ?? window;
  const doc = init.doc ?? document;
  const wake = (): void => onWake();
  const onVisibility = (): void => {
    if (doc.visibilityState === "visible") onWake();
  };

  win.addEventListener("online", wake);
  win.addEventListener("pageshow", wake);
  doc.addEventListener("resume", wake);
  doc.addEventListener("visibilitychange", onVisibility);

  return () => {
    win.removeEventListener("online", wake);
    win.removeEventListener("pageshow", wake);
    doc.removeEventListener("resume", wake);
    doc.removeEventListener("visibilitychange", onVisibility);
  };
}
