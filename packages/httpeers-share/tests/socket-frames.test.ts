import { describe, expect, it } from "vitest";
import { decodeFrames, encodeFrame, type SocketFrame } from "../src/socket-frames.js";

async function roundTrip(frames: SocketFrame[], chunking: (bytes: Uint8Array) => Uint8Array[]) {
  const bytes = new Uint8Array(frames.flatMap((f) => [...encodeFrame(f)]));
  const source = new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunking(bytes)) c.enqueue(chunk);
      c.close();
    },
  });
  const out: SocketFrame[] = [];
  for await (const frame of source.pipeThrough(decodeFrames())) out.push(frame);
  return out;
}

const FRAMES: SocketFrame[] = [
  { type: "open", protocol: "vite-hmr" },
  { type: "text", data: "héllo" },
  { type: "binary", data: new Uint8Array([0, 1, 2, 255]) },
  { type: "text", data: "" },
  { type: "close", code: 1000, reason: "bye" },
];

describe("socket frames", () => {
  it("round-trip text, binary and close", async () => {
    expect(await roundTrip(FRAMES, (b) => [b])).toEqual(FRAMES);
  });

  it("survive any chunking of the byte stream, down to one byte at a time", async () => {
    expect(await roundTrip(FRAMES, (b) => [...b].map((x) => new Uint8Array([x])))).toEqual(FRAMES);
  });
});
