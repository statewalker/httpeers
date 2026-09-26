import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// jsdom implements none of these: assistant-ui's Thread measures its content with a
// ResizeObserver and auto-scrolls the viewport with `Element.scrollTo` (Task 7's `tests/
// thread.test.tsx` is the first to actually mount that viewport), and Radix's Tabs/Dialog
// scroll elements into view when the selection changes.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};
Element.prototype.scrollTo ??= () => {};

afterEach(() => {
  cleanup();
});
