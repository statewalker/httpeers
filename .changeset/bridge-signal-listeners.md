---
"@statewalker/httpeers-bridge": patch
---

A caller's `AbortSignal` reused across many calls no longer collects an abort listener per call: the signal merged for a call stops following the caller's once the response head is in. The response body is pulled only when the consumer reads it.
