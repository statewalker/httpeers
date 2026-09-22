import { cleanup } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// jsdom implements neither: assistant-ui's Thread measures its content with a ResizeObserver,
// and Radix's Tabs/Dialog scroll elements into view when the selection changes.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver as unknown as typeof ResizeObserver;
Element.prototype.scrollIntoView ??= () => {};

afterEach(() => {
  cleanup();
});
