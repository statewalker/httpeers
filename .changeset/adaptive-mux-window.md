---
"@statewalker/httpeers-libp2p": minor
---

The mux's per-port window is now adaptive by default (#128, on webrun-rpc 0.15's adaptive window). A port starts at 256 KiB. After the ack, the window each side grants follows about one bandwidth-delay product: it grows where 256 KiB capped a bulk transfer (fast or long paths) and shrinks back where more would only queue. It never goes below the window agreed when the port opened. The defaults are `DEFAULT_MUX_ADAPTIVE_WINDOW`: a 64 KiB floor, 16 MiB per port, and 32 MiB per peer in all. Pass `window: <bytes>` to keep a fixed window, or `window: { initial, min, max, budget }` to size the adaptive one. Peers on older versions interoperate unchanged: they keep the window agreed at the open.
