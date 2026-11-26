---
"@statewalker/httpeers-member": patch
---

`createGateway` removes a caller's mesh token (`x-httpeers-token`) before dispatch, so every call goes out with the member's own token; `forwardCallerToken: true` keeps the old pass-through.
