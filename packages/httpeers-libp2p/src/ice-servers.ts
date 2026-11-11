/**
 * Which STUN/TURN servers a node's `webRTC()` transport asks for ICE candidates.
 *
 * OPT-IN, AND WHY. Leaving `iceServers` unset keeps `@libp2p/webrtc`'s own default list (four
 * public STUN servers: Google, Twilio, Cloudflare, Mozilla), which is what every node used
 * before this existed. `HTTPEERS_ICE_SERVERS` puts the mesh's own server first
 * (`stun:stun.httpeers.net:3478`, deploy/README.md "The STUN server") with one public server
 * behind it, and a caller chooses it by passing it. It is not the default because a default
 * that names a server is only as good as that server's deployment: until it answers, a node on
 * that list would have one working STUN server where it had four.
 *
 * WHAT AN UNREACHABLE SERVER COSTS. Little: `@libp2p/webrtc` trickles candidates over the
 * signalling stream as they are gathered and never waits for gathering to complete, so a STUN
 * server that never answers contributes no `srflx` candidate and delays none of the others.
 *
 * STRUCTURAL, NOT THE DOM's `RTCIceServer`. This package compiles without the DOM lib (see
 * tsconfig.json); the shape is the same, so a page can pass its own `RTCIceServer[]` unchanged.
 */

/** One ICE server, as `RTCConfiguration.iceServers` takes it. */
export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** The mesh's own STUN server. STUN only: it relays nothing (no TURN). */
export const HTTPEERS_STUN_URL = "stun:stun.httpeers.net:3478";

/** The public server behind it in `HTTPEERS_ICE_SERVERS`. */
export const PUBLIC_STUN_FALLBACK_URL = "stun:stun.l.google.com:19302";

/** The mesh's STUN server first, then one public fallback. Pass it as `iceServers` to opt in. */
export const HTTPEERS_ICE_SERVERS: readonly IceServer[] = Object.freeze([
  Object.freeze({ urls: HTTPEERS_STUN_URL }),
  Object.freeze({ urls: PUBLIC_STUN_FALLBACK_URL }),
]);

/**
 * The `webRTC()` init for an `iceServers` choice: `{}` when it is unset, so the transport keeps
 * its own default; otherwise a fresh, unfrozen copy: `@libp2p/webrtc` assigns into the
 * configuration object it is given (`getRtcConfiguration`), and the list may be a frozen
 * constant shared by every node.
 *
 * An EMPTY list is passed through, not treated as unset: it means "host candidates only", which
 * is what a loopback test wants and what `undefined` cannot say.
 */
export function webRTCInitOf(iceServers?: readonly IceServer[]): {
  rtcConfiguration?: { iceServers: IceServer[] };
} {
  if (iceServers == null) return {};
  return {
    rtcConfiguration: {
      iceServers: iceServers.map((s) => ({
        ...s,
        urls: Array.isArray(s.urls) ? [...s.urls] : s.urls,
      })),
    },
  };
}

const ICE_URL = /^(stun|stuns|turn|turns):[^\s,]+$/;

/**
 * Parse a comma-separated list of ICE server URLs, as an environment variable carries it
 * (`stun:stun.httpeers.net:3478,stun:stun.l.google.com:19302`).
 *
 * `undefined` for an unset or blank value (keep the transport's default). `none` is the empty
 * list (host candidates only). Each URL must start `stun:`, `stuns:`, `turn:` or `turns:`; one
 * that does not is an error naming it, because a mistyped server is otherwise silently a node
 * without one. No credentials: a TURN server that needs them is configured in code.
 */
export function parseIceServers(value: string | undefined): IceServer[] | undefined {
  const text = value?.trim() ?? "";
  if (text === "") return undefined;
  if (text === "none") return [];
  return text
    .split(",")
    .map((url) => url.trim())
    .filter((url) => url !== "")
    .map((url) => {
      if (!ICE_URL.test(url)) {
        throw new Error(
          `ICE server "${url}" is not a stun:, stuns:, turn: or turns: URL ` +
            `(e.g. ${HTTPEERS_STUN_URL})`,
        );
      }
      return { urls: url };
    });
}
