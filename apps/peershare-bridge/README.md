# @statewalker/peershare-bridge

> Private: shipped as compiled binaries, not published to npm.

## What it is

The PeerShare Bridge as a program. It listens on `127.0.0.1`, prints (and with `--open`,
opens) the PeerShare link that pairs the page with it, and relays the page's requests to the
Sharer's local services. The relay itself is `@statewalker/httpeers-share/bridge`.

## How to use

```sh
pnpm start                      # bun run src/main.ts --open
pnpm compile                    # one file: dist/peershare-bridge
dist/peershare-bridge --port 9090 --origin https://tools.sandclaw.ai --open
```

`PEERSHARE_OPEN` replaces the platform's opener (`open`, `xdg-open`, `explorer`).
Cookie jars are on (each Guest's cookie logins are kept apart); `--no-cookie-jars` turns them off.

### Every platform

```sh
pnpm compile:all          # dist/peershare-bridge-{linux-x64,linux-arm64,macos-x64,macos-arm64,windows-x64.exe}
```

Each one is self-contained (89–115 MB, almost all of it the Bun runtime);
`tests/targets.test.ts` cross-compiles each and checks it is an executable for its
platform. Only the host's own build is run here (`tests/binary.test.ts`).

### Signing (needs the publisher's certificates; not done in CI here)

- **macOS:** sign with a Developer ID Application certificate and the hardened runtime,
  then notarise. Without this, Gatekeeper blocks a downloaded binary.
  ```sh
  codesign --sign "Developer ID Application: …" --options runtime --timestamp \
    --entitlements entitlements.plist dist/peershare-bridge-macos-arm64
  xcrun notarytool submit peershare-bridge-macos-arm64.zip --keychain-profile peershare --wait
  ```
  Bun's JIT needs `com.apple.security.cs.allow-jit` and
  `com.apple.security.cs.allow-unsigned-executable-memory` in `entitlements.plist`.
- **Windows:** Authenticode-sign the `.exe` (`signtool sign /fd SHA256 /tr <timestamp-url> /td SHA256 …`).
  Unsigned, SmartScreen warns on first run.
- **Linux:** publish a SHA-256 checksum next to each file.

## Internals

`tests/cli.test.ts` runs it under Bun. `tests/binary.test.ts` compiles it and runs the binary
with an empty `PATH`. `tests/targets.test.ts` builds every platform. The download page is part
of PeerShare's page (in sandclaw).

## License

MIT
