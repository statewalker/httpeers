/**
 * WHERE THIS CAME FROM, AND WHY IT IS HERE. It shipped inside
 * `@statewalker/webrun-http-proxy` while that package also owned routing. It
 * does not any more: routing is a plain Hono router in `../proxy/main.ts`, and
 * the SHAPE of a persisted route is whoever defines the routes' business — so
 * the store came with them. The secret rule below is the part worth keeping.
 *
 * Original:
 * Persisting routes — and refusing, mechanically, to persist a secret.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. A route may carry a credential: an
 * upstream API key, a bearer token, whatever the operator typed into the proxy
 * page. The header's NAME is configuration and is saved. The header's VALUE is
 * a secret, lives in memory, and is merged per request.
 *
 * That distinction cannot be left to callers. An earlier shape of this API
 * stored a whole `Route`, and building the proxy page on it would have written
 * bearer keys into `localStorage` — where they survive a reload, a shared
 * machine, and anyone who opens devtools. So `StoredRoute` has no field a
 * value could go in, and `save()` throws rather than silently dropping one:
 * silently dropping would mean a route that worked before a reload and
 * mysteriously 401s after it.
 *
 * `load()` RETURNS `undefined` FOR "NEVER WRITTEN", which is not the same as
 * an empty array and the difference is visible to a user. A first visit should
 * seed the demo routes; a visit after the operator deleted all of them should
 * not bring them back. One value distinguishes the two.
 */

/**
 * A route as it is persisted: the upstream as a URL, and the header NAME only.
 *
 * There is deliberately no field for a header value. The type is the
 * enforcement; `save()`'s check is the belt to its braces.
 */
export interface StoredRoute {
  prefix: string;
  /** The upstream base URL. A route whose upstream is a live handler cannot be stored. */
  upstream: string;
  describe: string;
  /** The name of the header carrying a credential, or `null` for none. */
  secretHeader: string | null;
}

export interface RouteStore {
  /** `undefined` means NEVER WRITTEN — distinct from `[]`, which means "the operator deleted them all". */
  load(): Promise<StoredRoute[] | undefined>;
  /** Throws if any route carries a credential VALUE. */
  save(routes: StoredRoute[]): Promise<void>;
}

/** Thrown when a caller tries to persist something that looks like a secret. */
export class SecretNotPersistableError extends Error {
  constructor(public readonly prefix: string) {
    super(
      `httpeers-demos: refusing to persist a credential value for route ${JSON.stringify(prefix)}. ` +
        "Store the header NAME (`secretHeader`) and keep the value in memory — a persisted " +
        "credential survives a reload, a shared machine, and devtools.",
    );
    this.name = "SecretNotPersistableError";
  }
}

/**
 * The check `save()` implementations run. Exported so an adapter written
 * elsewhere enforces the same rule rather than reimplementing its own idea of
 * what a secret looks like.
 */
export function assertNoSecrets(routes: readonly StoredRoute[]): void {
  for (const route of routes) {
    const carrier = route as unknown as Record<string, unknown>;
    // Any shape a value could arrive in. A caller passing a whole `Route`
    // through by mistake is the case this catches, and it is the likely one.
    if (
      typeof carrier.secret === "string" ||
      typeof carrier.secretValue === "string" ||
      (carrier.headers != null && typeof carrier.headers === "object")
    ) {
      throw new SecretNotPersistableError(route.prefix);
    }
  }
}

/** Keep only the persistable fields, dropping anything else a caller passed. */
export function toStoredRoute(route: {
  prefix: string;
  upstream: string;
  describe: string;
  secretHeader?: string | null;
}): StoredRoute {
  return {
    prefix: route.prefix,
    upstream: route.upstream,
    describe: route.describe,
    secretHeader: route.secretHeader ?? null,
  };
}

const DEFAULT_KEY = "webrun:proxy:routes";

export function localStorageRouteStore(key: string = DEFAULT_KEY): RouteStore {
  return {
    async load() {
      const raw = globalThis.localStorage?.getItem(key);
      // `null` from `getItem` means never written. Distinct from `"[]"`.
      if (raw == null) return undefined;
      try {
        return JSON.parse(raw) as StoredRoute[];
      } catch {
        // Corrupt is not "never written": resurrecting defaults over a table
        // somebody edited would be worse than starting empty and saying so.
        return [];
      }
    },
    async save(routes) {
      assertNoSecrets(routes);
      globalThis.localStorage?.setItem(key, JSON.stringify(routes));
    },
  };
}
