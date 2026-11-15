---
"@statewalker/httpeers-member": patch
---

The optional peer `@statewalker/webrun-http-browser` may now be `^0.17.1` as well as `^0.7.1`, `^0.13.0` or `^0.16.0`. The member takes only `SwHttpAdapter` from its `/sw` entry, whose typings and exports are identical in 0.16 and 0.17; 0.17 shares webrun-rpc 0.15 with `httpeers-libp2p`, so a browser bundle carries one copy.
