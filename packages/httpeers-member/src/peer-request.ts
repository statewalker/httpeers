/**
 * A `Request` addressed at a mesh path.
 *
 * `Peer.call(peerId, request)` takes a whole `Request`, because that is the
 * contract every other seam in this system speaks — the prototype's peer took
 * `(peerId, path, init)` instead, which meant it owned a second, narrower idea
 * of what a call is and could not carry anything a `Request` can (a stream, an
 * `AbortSignal`, a `Headers` instance a caller already had).
 *
 * The origin is a placeholder and is never dialled: the far side routes on the
 * pathname alone. It is spelled `peer.local` rather than `localhost` so that a
 * stray log line cannot be mistaken for a loopback request that really went out.
 */
export interface PeerRequestInit extends RequestInit {
  /**
   * A membership token, placed in `Authorization: Bearer`.
   *
   * The prototype's `peer.call` took this as its own option and built the
   * header internally. Keeping it here rather than making every call site
   * write the header keeps those sites reading as intent — and keeps ONE
   * place that decides the scheme, which is what a token's format being
   * changed later will want.
   */
  token?: string;
}

export function peerRequest(path: string, init: PeerRequestInit = {}): Request {
  const { token, headers, ...rest } = init;
  const merged = new Headers(headers);
  if (token != null) merged.set("authorization", `Bearer ${token}`);
  return new Request(`http://peer.local${path.startsWith("/") ? path : `/${path}`}`, {
    ...rest,
    headers: merged,
  });
}
