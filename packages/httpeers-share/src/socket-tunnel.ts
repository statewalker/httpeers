/**
 * A WebSocket inside one request over the mesh (M9; rung 15 measured that a
 * mesh request is full-duplex). The Guest's `openTunnel` sends frames in the
 * request body and reads them from the response body; the Sharer's
 * `sharerSocket` relays them to the Service's own socket.
 */

import type { FetchHandler } from "@statewalker/webrun-http-proxy";
import { decodeFrames, encodeFrame, SOCKET_HEADER, type SocketFrame } from "./socket-frames.js";

/** The Sharer's side: answer a tunnel request by relaying to `open()`'s socket. */
export function sharerSocket(request: Request, open: () => WebSocket): Response {
  const ws = open();
  ws.binaryType = "arraybuffer";
  const held: Array<string | ArrayBuffer> = [];
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let done = false;
  const emit = (frame: SocketFrame) => {
    if (!done) out.enqueue(encodeFrame(frame));
  };
  const end = (code: number, reason: string) => {
    emit({ type: "close", code, reason });
    if (!done) {
      done = true;
      out.close();
    }
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      out = controller;
      ws.onopen = () => {
        emit({ type: "open", protocol: ws.protocol });
        for (const data of held.splice(0)) ws.send(data);
      };
      ws.onmessage = (e) =>
        emit(
          typeof e.data === "string"
            ? { type: "text", data: e.data }
            : { type: "binary", data: new Uint8Array(e.data as ArrayBuffer) },
        );
      ws.onclose = (e) => end(e.code, e.reason);
      ws.onerror = () => end(1011, "the Service's socket failed");
    },
    cancel() {
      done = true;
      ws.close();
    },
  });

  // The Guest's frames, as they arrive: the request is still open.
  void (async () => {
    if (request.body == null) return;
    for await (const frame of request.body.pipeThrough(decodeFrames())) {
      if (frame.type === "close") {
        ws.close(frame.code === 1000 || frame.code >= 3000 ? frame.code : 1000, frame.reason);
      } else if (frame.type === "text" || frame.type === "binary") {
        const data = frame.type === "text" ? frame.data : frame.data.slice().buffer;
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
        else held.push(data);
      }
    }
  })().catch(() => ws.close(1011));

  return new Response(body, { headers: { "content-type": "application/octet-stream" } });
}

type Listener<E> = ((event: E) => void) | null;

/** What a Guest holds: shaped like a browser WebSocket, carried over `fetch`. */
export class TunnelSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readyState = TunnelSocket.CONNECTING;
  protocol = "";
  onopen: Listener<{ type: "open" }> = null;
  onmessage: Listener<{ type: "message"; data: string | ArrayBuffer }> = null;
  onclose: Listener<{ type: "close"; code: number; reason: string; wasClean: boolean }> = null;
  onerror: Listener<{ type: "error" }> = null;

  private out!: ReadableStreamDefaultController<Uint8Array>;
  private sentClose = false;

  constructor(fetch: FetchHandler, path: string, protocols: string[]) {
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.out = controller;
      },
    });
    // `path` may be a full URL (`http://local/peers/<sharer>/s/<id>/live`), so
    // the caller's `fetch` gets the Request as built, streaming body and all.
    void fetch(
      new Request(/^https?:/.test(path) ? path : `http://tunnel${path}`, {
        method: "POST",
        headers: { [SOCKET_HEADER]: protocols.join(",") },
        body,
        duplex: "half",
      } as RequestInit),
    )
      .then((res) => this.read(res))
      .catch(() => this.closed(1006, "the tunnel failed"));
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== TunnelSocket.OPEN) throw new Error("the socket is not open");
    const frame: SocketFrame =
      typeof data === "string"
        ? { type: "text", data }
        : {
            type: "binary",
            data:
              data instanceof ArrayBuffer
                ? new Uint8Array(data)
                : new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
          };
    this.out.enqueue(encodeFrame(frame));
  }

  close(code = 1000, reason = ""): void {
    if (this.readyState >= TunnelSocket.CLOSING) return;
    this.readyState = TunnelSocket.CLOSING;
    this.endRequest(code, reason);
  }

  private endRequest(code: number, reason: string): void {
    if (this.sentClose) return;
    this.sentClose = true;
    try {
      this.out.enqueue(encodeFrame({ type: "close", code, reason }));
      this.out.close();
    } catch {
      /* already closed */
    }
  }

  private async read(res: Response): Promise<void> {
    if (!res.ok || res.body == null) {
      this.onerror?.({ type: "error" });
      return this.closed(1011, `refused: ${res.status}`);
    }
    for await (const frame of res.body.pipeThrough(decodeFrames())) {
      if (frame.type === "open") {
        this.protocol = frame.protocol;
        this.readyState = TunnelSocket.OPEN;
        this.onopen?.({ type: "open" });
      } else if (frame.type === "text") this.onmessage?.({ type: "message", data: frame.data });
      else if (frame.type === "binary")
        this.onmessage?.({ type: "message", data: frame.data.slice().buffer });
      else return this.closed(frame.code, frame.reason);
    }
    this.closed(1006, "the tunnel ended");
  }

  private closed(code: number, reason: string): void {
    if (this.readyState === TunnelSocket.CLOSED) return;
    this.readyState = TunnelSocket.CLOSED;
    this.endRequest(1000, "");
    this.onclose?.({ type: "close", code, reason, wasClean: code === 1000 });
  }
}

export function openTunnel(fetch: FetchHandler, path: string, protocols: string[]): TunnelSocket {
  return new TunnelSocket(fetch, path, protocols);
}
