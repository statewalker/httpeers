/**
 * A service the hub serves itself -- the LLM service is one.
 *
 * ONE HANDLER, TWO WAYS IN. The mesh mounts it at `/<id>` behind `withAccess`
 * (a member's token, the transport-proven peer); the local door calls it
 * directly, with no access layer, because a request on the door has no
 * transport-proven peer and `withAccess` would refuse it 401. `caller` says
 * which way a request came, so a module that must behave differently for the
 * local operator (it holds no mesh token) can tell.
 *
 * THE PATH IS THE MOUNT'S PATH, prefix included: `/<id>/...` on both ways in.
 * The mesh router hands a mount the full path, and the door rewrites
 * `/peers/<hubPeerId>/<id>/...` to the same shape, so a module never has to
 * know where it was reached from to route.
 */

export interface ServiceModule {
  /** The mount prefix `/<id>`, and the advertisement's id. */
  id: string;
  advertisement: { id: string; kind: string; title: string };
  /** Datalog rules and policies, appended to the hub's rule set at load time. */
  rules: string[];
  policies: string[];
  handler(request: Request, context: ServiceContext): Promise<Response>;
}

export interface ServiceContext {
  hubPeerId: string;
  /** The first path segment a browser uses to reach a peer: `/peers/<hubPeerId>/<service>/...`. */
  edgeKey: "peers";
  caller: "mesh" | "local";
}
