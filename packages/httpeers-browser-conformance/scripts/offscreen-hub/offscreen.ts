/**
 * The offscreen document of `../offscreen-hub.mjs`'s test extension: a hub,
 * assembled with `startBrowserHub` and nothing else, answering the service
 * worker's messages. Bundled from the packages' SOURCES, without
 * `@statewalker/webrun-http-browser` (the build fails if anything asks for it).
 */

import { ruleSet } from "@statewalker/httpeers-access";
import { generateKey } from "@statewalker/httpeers-libp2p";
import { type BrowserHubHandle, startBrowserHub } from "@statewalker/httpeers-member/browser-hub";

type Message = { target?: string; cmd?: string; relayAddr?: string; peerId?: string };
declare const chrome: {
  runtime: {
    onMessage: {
      addListener(
        listener: (message: Message, sender: unknown, reply: (answer: unknown) => void) => unknown,
      ): void;
    };
  };
};

// std:* are the mesh protocol's own: without std:presence.write no member is
// ever online, and nothing reports the refusal.
const RULES = ruleSet({
  version: 1,
  rules: [
    'capability("std:mesh.read") <- role("member")',
    'capability("std:presence.write") <- role("member")',
    'capability("test:ping") <- role("member")',
  ],
  policies: [
    'allow if capability("std:mesh.read"), resource("/.well-known") or capability("std:mesh.read"), resource($r), $r.starts_with("/.well-known/")',
    'allow if capability("test:ping"), resource("/ping")',
  ],
});

let handle: BrowserHubHandle | undefined;

async function run(message: Message): Promise<unknown> {
  switch (message.cmd) {
    case "start": {
      handle = await startBrowserHub({
        privateKey: await generateKey(),
        relayAddrs: [message.relayAddr ?? ""],
        rules: RULES,
        storageName: "offscreen-hub-test",
        dev: true,
        // A headless browser's WebRTC upgrade may not complete on every
        // runner; the member then stays on the relayed circuit, which the hub
        // must be willing to serve (relay-only mode). Either way the request
        // crosses libp2p into this document.
        serveOnLimitedConnection: true,
        extraMounts: { "/ping": async () => Response.json({ pong: true }) },
      });
      const invitation = await handle.hub.invitations.create(["member"], 10 * 60_000);
      return {
        peerId: handle.peerId,
        circuitAddr: handle.circuitAddr,
        invitationId: invitation.id,
        hasWebRTC: typeof (globalThis as { RTCPeerConnection?: unknown }).RTCPeerConnection,
      };
    }
    case "isMember":
      return handle?.hub.isMember(message.peerId ?? "") ?? false;
    case "stop":
      await handle?.stop();
      return true;
    default:
      throw new Error(`unknown command ${message.cmd}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, reply) => {
  if (message?.target !== "offscreen") return undefined;
  run(message).then(
    (result) => reply({ ok: true, result }),
    (error: unknown) =>
      reply({ ok: false, error: String((error as { stack?: string })?.stack ?? error) }),
  );
  return true; // the reply is asynchronous
});
