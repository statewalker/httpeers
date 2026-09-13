// A throwaway worker for the lifecycle tests. It does nothing on purpose:
// these tests are about REGISTRATION lifetime, not about routing, and a worker
// that intercepted fetches would make a failure ambiguous between "the reset
// did not work" and "the worker mishandled a request".
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
