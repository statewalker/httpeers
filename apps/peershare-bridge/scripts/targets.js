/** The platforms the Bridge ships for: Bun's cross-compilation targets. */
export const TARGETS = [
  { target: "bun-linux-x64", os: "linux", file: "peershare-bridge-linux-x64" },
  { target: "bun-linux-arm64", os: "linux", file: "peershare-bridge-linux-arm64" },
  { target: "bun-darwin-x64", os: "darwin", file: "peershare-bridge-macos-x64" },
  { target: "bun-darwin-arm64", os: "darwin", file: "peershare-bridge-macos-arm64" },
  { target: "bun-windows-x64", os: "windows", file: "peershare-bridge-windows-x64.exe" },
];
