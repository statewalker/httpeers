---
"@statewalker/httpeers-member": patch
---

The optional peer `@statewalker/webrun-http-browser` may now be `^0.16.0` as well as `^0.7.1` or `^0.13.0`. The member takes only `SwHttpAdapter` from its `/sw` entry, which is unchanged across these lines; 0.16 shares webrun-rpc 0.14, webrun-streams 0.6 and webrun-http-streams 0.8 with `httpeers-libp2p`, so a browser bundle carries one copy of each.
