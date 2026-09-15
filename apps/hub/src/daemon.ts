/**
 * The hub daemon: one call from a config and the enabled modules to a hub
 * serving the mesh and the local door.
 *
 * THE ORDER, and why each step is where it is:
 *
 *   identity -> rules -> relay document -> node (late-bound gater)
 *     -> reservation + supervisor -> createHub (file state) -> revocations
 *     -> point the gater at the member store -> servePeer -> local door -> READY
 *
 * - Rules load BEFORE anything touches the network, so a broken `rules.dl`
 *   fails the start at once instead of after a relay round trip.
 * - The hub reserves on the relay BEFORE it serves, as the harness hub does: by
 *   the time a member dials, the hub is reachable the way a member reaches it.
 * - `READY` is printed last, once, when both ways in are serving.
 *
 * SERVES ON LIMITED CONNECTIONS. A hub in Docker on a bridge network cannot be
 * reached over WebRTC, and its members fall back to a kept relay circuit
 * through the public relay. `serveOnLimitedConnection` is what lets the hub
 * answer them. It does not open the hub's own relay to application traffic:
 * that limit is on the relay server, not on this flag.
 *
 * REVOCATIONS ARE ENFORCED ON THE HUB'S OWN ENDPOINTS. The harness and the
 * demos pass no `revocation` to the hub's `withAccess`; this daemon passes the
 * hub's registry, so a revoked member's still-valid token is refused here too,
 * and -- through `persistentRevocations` -- still refused after a restart.
 */

import { join } from "node:path";
import { type RuleSet, selfCertifyingKeys, withAccess } from "@statewalker/httpeers-access";
import { mintToken } from "@statewalker/httpeers-access/issuer";
import { ANONYMOUS, type FetchHandler, lookupPeer } from "@statewalker/httpeers-core";
import { createHub, type Hub, usesTransportIdentity } from "@statewalker/httpeers-hub";
import { fileStorage } from "@statewalker/httpeers-hub/node";
import { servePeer, signerOf } from "@statewalker/httpeers-libp2p";
import type { HubConfig } from "./config.js";
import { loadOrCreateIdentity } from "./identity.js";
import { startLocalDoor } from "./local-door.js";
import { connectRelay, createHubNode, readRelayDoc } from "./node.js";
import { loadOrCreateRules } from "./rules.js";
import type { ServiceModule } from "./service-module.js";
import { persistentRevocations, REVOCATIONS_FILE } from "./state.js";

/**
 * The longest life of a token this hub mints, and so the revocation horizon.
 * Members refresh on every heartbeat, so this bounds how long a revoked token
 * could matter, not how long a member stays in.
 */
export const TOKEN_TTL_MS = 15 * 60_000;
export const SWEEP_INTERVAL_MS = 5_000;

/** Mount prefixes the hub's own endpoints use; a module may not take one. */
const RESERVED_IDS = new Set([".well-known", "admin", "test", "hub"]);

export interface Daemon {
  hubPeerId: string;
  /**
   * The hub, in process: what the admin API and the local UI act on, and how a
   * test mints an invitation.
   */
  hub: Hub;
  rules: RuleSet;
  relayAddrs: string[];
  /** The relay address this hub holds its reservation on. */
  relayAddr: string;
  localDoorPort: number;
  stop(): Promise<void>;
}

function assertModules(modules: ServiceModule[]): void {
  const seen = new Set<string>();
  for (const m of modules) {
    if (!/^[A-Za-z0-9_-]+$/.test(m.id) || RESERVED_IDS.has(m.id)) {
      throw new Error(`hub: a service module cannot be mounted at "/${m.id}"`);
    }
    if (seen.has(m.id)) throw new Error(`hub: service module "${m.id}" is registered twice`);
    seen.add(m.id);
  }
}

export async function startDaemon(config: HubConfig, modules: ServiceModule[]): Promise<Daemon> {
  assertModules(modules);
  const hubDir = join(config.dataDir, "hub");

  const { privateKey, peerId: hubPeerId } = await loadOrCreateIdentity(hubDir);
  console.log(`hub: identity ${hubPeerId}`);
  const rules = loadOrCreateRules(hubDir, modules);

  const relayAddrs = await readRelayDoc(config.relayDoc);

  // Late-bound: the member store does not exist until `createHub` runs.
  let isMember = (_peerId: string): boolean => false;
  const node = await createHubNode({ privateKey, isMember: () => isMember });

  const unwind: Array<() => void | Promise<void>> = [() => node.stop()];
  const teardown = async () => {
    for (const step of unwind.splice(0).reverse()) {
      try {
        await step();
      } catch {
        /* teardown: report the failure that caused it, not this */
      }
    }
  };

  try {
    const { relayAddr, supervisor } = await connectRelay(node, relayAddrs);
    unwind.push(() => supervisor.stop());
    console.log(`hub: reserved on ${relayAddr}`);

    const extraMounts: Record<string, FetchHandler> = {};
    for (const m of modules) {
      extraMounts[`/${m.id}`] = (request) =>
        m.handler(request, { hubPeerId, edgeKey: "peers", caller: "mesh" });
    }

    // THE SAME KEY SIGNS AND SPEAKS: tokens name the peer members talk to.
    const signer = signerOf(privateKey);
    const hub = await createHub({
      selfPeerId: hubPeerId,
      policies: rules,
      storage: fileStorage(join(hubDir, "state", "hub")),
      sweepIntervalMs: SWEEP_INTERVAL_MS,
      maxTokenTtlMs: TOKEN_TTL_MS,
      extraMounts,
      ownAdvertisements: modules.map((m) => m.advertisement),
      mintToken: async (sub, roles, options) =>
        mintToken({
          signer,
          sub,
          roles,
          ttlMs: Math.min(options?.ttlMs ?? TOKEN_TTL_MS, TOKEN_TTL_MS),
          ...(options?.audience != null ? { audience: options.audience } : {}),
        }),
    });
    unwind.push(() => hub.stop());

    const revocations = await persistentRevocations(
      join(hubDir, REVOCATIONS_FILE),
      hub.revocations,
      { maxTokenTtlMs: TOKEN_TTL_MS },
    );
    unwind.push(() => revocations.flushed());
    isMember = (peerId) => hub.isMember(peerId);

    const peer = await servePeer({
      node,
      mounts: hub.mounts,
      access: withAccess({
        issuer: hubPeerId,
        rules,
        selfPeer: hubPeerId,
        keys: selfCertifyingKeys(),
        provenPeer: (request) => lookupPeer(request) ?? ANONYMOUS,
        // The bootstrap routes MINT the tokens they cannot require.
        bootstrap: usesTransportIdentity(),
        revocation: hub.revocations,
      }),
      serveOnLimitedConnection: true,
    });
    unwind.push(() => peer.stop());

    const door = await startLocalDoor({ port: config.localDoorPort, hubPeerId, modules });
    unwind.push(() => door.stop());
    console.log(`hub: local door on port ${door.port}`);

    console.log(`READY ${hubPeerId}`);

    let stopping: Promise<void> | undefined;
    return {
      hubPeerId,
      hub,
      rules,
      relayAddrs,
      relayAddr,
      localDoorPort: door.port,
      stop() {
        stopping ??= teardown();
        return stopping;
      },
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}
