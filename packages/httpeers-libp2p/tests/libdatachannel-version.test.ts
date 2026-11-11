/**
 * The libdatachannel that `@libp2p/webrtc` actually loads under Node is
 * 0.24.6 or newer, and the startup check that warns when it is not.
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
 * matters is the one libp2p imports (`loadedLibdatachannelVersion`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIBDATACHANNEL_MIN_VERSION,
  libdatachannelWarning,
  loadedLibdatachannelVersion,
  versionAtLeast,
  warnIfOldLibdatachannel,
} from "../src/node.js";

describe("bundled libdatachannel", () => {
  // DELIBERATELY FAILS, NEVER SKIPS, when node-datachannel cannot be loaded
  // (a missing `@node-datachannel/<platform>` package, a broken install):
  // `loadedLibdatachannelVersion` throws and the test fails with that error.
  // A skip would read as green in exactly the install where WebRTC is broken.
  it(`is ${LIBDATACHANNEL_MIN_VERSION} or newer (the DTLS startup fix)`, () => {
    const version = loadedLibdatachannelVersion();
    expect(versionAtLeast(version, LIBDATACHANNEL_MIN_VERSION), `libdatachannel ${version}`).toBe(
      true,
    );
  });
});

describe("versionAtLeast", () => {
  it("compares part by part, numerically", () => {
    expect(versionAtLeast("0.24.6", "0.24.6")).toBe(true);
    expect(versionAtLeast("0.24.10", "0.24.6")).toBe(true);
    expect(versionAtLeast("0.25.0", "0.24.6")).toBe(true);
    expect(versionAtLeast("1.0.0", "0.24.6")).toBe(true);
    expect(versionAtLeast("0.24.5", "0.24.6")).toBe(false);
    expect(versionAtLeast("0.9.99", "0.24.6")).toBe(false);
    expect(versionAtLeast("0.23.99", "0.24.6")).toBe(false);
  });

  it("treats a missing part as 0", () => {
    expect(versionAtLeast("0.25", "0.24.6")).toBe(true);
    expect(versionAtLeast("0.24", "0.24.6")).toBe(false);
    expect(versionAtLeast("0.24.6.1", "0.24.6")).toBe(true);
  });

  it("ignores a leading v and a pre-release or build suffix", () => {
    expect(versionAtLeast("v0.24.6", "0.24.6")).toBe(true);
    expect(versionAtLeast("0.24.6-rc1", "0.24.6")).toBe(true);
    expect(versionAtLeast("0.24.5+abc", "0.24.6")).toBe(false);
  });

  it("answers false for a version it cannot read", () => {
    expect(versionAtLeast("", "0.24.6")).toBe(false);
    expect(versionAtLeast("unknown", "0.24.6")).toBe(false);
    expect(versionAtLeast("0.x.6", "0.24.6")).toBe(false);
  });
});

describe("the startup check", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("has a warning for a libdatachannel without the fix, naming both versions", () => {
    const warning = libdatachannelWarning("0.24.5");
    expect(warning).toContain("0.24.5");
    expect(warning).toContain(LIBDATACHANNEL_MIN_VERSION);
    expect(warning).toContain("node-datachannel >= 0.33.6");
  });

  it("has none for one with the fix", () => {
    expect(libdatachannelWarning("0.24.6")).toBeUndefined();
    expect(libdatachannelWarning("0.25.0")).toBeUndefined();
  });

  it("stays quiet with the installed node-datachannel, and never throws", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => warnIfOldLibdatachannel()).not.toThrow();
    expect(() => warnIfOldLibdatachannel()).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });
});
