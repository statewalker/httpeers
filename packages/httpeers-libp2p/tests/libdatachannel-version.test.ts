/**
 * The libdatachannel that `@libp2p/webrtc` actually loads under Node is
 * 0.24.6 or newer.
 *
 * WHY. libdatachannel <= 0.24.5 could lose a race on the WebRTC OFFERER:
 * setting the remote answer handed it to the ICE agent before the answer's
 * fingerprint was committed, so DTLS could start with no fingerprint to check
 * (`DTLS alert: unknown CA`) and the dial timed out. A busy CPU made it common.
 * Fixed upstream in libdatachannel 0235225 ("start DTLS after remote
 * description"), first released in 0.24.6, which node-datachannel bundles from
 * 0.33.6. httpeers used to retry every WebRTC dial for it; it now dials once
 * (`reachHub`, the member's pre-dials) and relies on the fix, so a lockfile or
 * override change that brings back an older node-datachannel must fail here.
 *
 * RESOLVED THROUGH `@libp2p/webrtc`, not from this package: the copy that
 * matters is the one libp2p imports.
 */
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const MIN = [0, 24, 6] as const;

function atLeast(version: string, min: readonly number[]): boolean {
  const parts = version.split(/[.-]/).map((p) => Number.parseInt(p, 10));
  for (let i = 0; i < min.length; i++) {
    const v = parts[i] ?? 0;
    const m = min[i] ?? 0;
    if (Number.isNaN(v)) return false;
    if (v !== m) return v > m;
  }
  return true;
}

describe("bundled libdatachannel", () => {
  it(`is ${MIN.join(".")} or newer (the DTLS startup fix)`, () => {
    const webrtcEntry = import.meta.resolve("@libp2p/webrtc");
    const requireFromWebrtc = createRequire(webrtcEntry);
    const nodeDatachannel = requireFromWebrtc("node-datachannel") as {
      getLibraryVersion(): string;
    };
    const version = nodeDatachannel.getLibraryVersion();
    expect(atLeast(version, MIN), `libdatachannel ${version}`).toBe(true);
  });

  it("compares versions numerically", () => {
    expect(atLeast("0.24.6", MIN)).toBe(true);
    expect(atLeast("0.24.10", MIN)).toBe(true);
    expect(atLeast("0.25.0", MIN)).toBe(true);
    expect(atLeast("1.0.0", MIN)).toBe(true);
    expect(atLeast("0.24.5", MIN)).toBe(false);
    expect(atLeast("0.9.99", MIN)).toBe(false);
  });
});
