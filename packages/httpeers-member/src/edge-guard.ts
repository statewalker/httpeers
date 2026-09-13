/**
 * The key/prefix guard, factored out of `edge.ts` on its own -- see that
 * module's doc comment for the full story of the trap this closes (design
 * note 39 §3, work item 1). Kept dependency-free and in its own file
 * DELIBERATELY: it is pure logic that needs no browser, but `edge.ts`
 * itself imports `@statewalker/webrun-http-browser/sw`, whose workspace
 * build has no committed `dist/` (note 39's own "published 0.3.3 and
 * workspace 0.3.3 are different artefacts" finding -- see this task's
 * report). Importing THIS file instead of `edge.ts` lets the guard's own
 * unit test run without depending on that package's build state at all.
 */

/**
 * `@statewalker/webrun-http-browser`'s `SwHttpDispatcher` (the
 * ServiceWorker side) keys a registration by the incoming URL's FIRST
 * PATH SEGMENT (`sw-dispatcher.ts`'s `_handleFetchEvent`); `SwHttpAdapter`
 * (the page side) registers a handler under a prefix matched against the
 * FULL base URL (`http-sw-dispatcher.ts`'s `_handleHttpRequest`). Nothing
 * connects the two: an adapter constructed with `key: 'peer-under-test'`
 * that then calls `register('mesh/', dispatch)` reports success at every
 * step -- constructed, started, registered, correct `baseUrl` -- while the
 * ServiceWorker looks up channel `'mesh'`, finds nothing registered under
 * that key, and the request falls through to the origin server. The
 * symptom looks exactly like a routing bug in httpeers; it is not one.
 *
 * Refuse to start instead, the same remedy `ruleSet()` applies to a policy
 * typo (`httpeers.core`'s `rules.ts`, `assertValid`) and note 39 §5
 * (work item 1) prescribes here: throw before `SwHttpAdapter.register` is
 * ever called, so a mismatch is a loud construction-time error rather than
 * a silent 404 three layers away.
 *
 * THE SECOND RULE -- THE TRAILING SLASH -- IS NEWER AND HAS ITS OWN TRAP.
 * `SwHttpRegistration.baseUrl` is `new URL("./" + prefix, rootUrl)`, so a
 * prefix with no trailing slash (`"app"`, or `"app/sub"`) produces a
 * baseUrl with none either. Since Ruling 58 that baseUrl is a published
 * contract -- `BrowserPeerHandle.baseUrl`, documented as always ending in
 * a slash, because every page-originated call composes
 * `${baseUrl}${peerId}/...`. A slash-less baseUrl silently yields
 * `/appPEERID/search`: a URL the ServiceWorker still routes (its key is
 * the first segment, `appPEERID`... which matches nothing), so the request
 * falls through to the origin server exactly like the first trap, and for
 * a reason just as invisible. No caller does this today; the point of a
 * guard is that none ever can.
 */
export function assertKeyMatchesPrefix(key: string, prefix: string): void {
  const firstSegment = prefix.split("/")[0];
  if (firstSegment !== key) {
    throw new Error(
      `mountEdge: prefix "${prefix}" does not start with adapter key "${key}" -- ` +
        "the ServiceWorker dispatcher keys a registration by the URL's first path segment " +
        "while the adapter matches the full base URL; a mismatch here means every mounting " +
        "step reports success while the handler is never called, and the request silently " +
        "falls through to the origin server (design note 39 §3). Refusing to start rather " +
        "than mount a registration nothing can ever reach.",
    );
  }
  if (!prefix.endsWith("/")) {
    throw new Error(
      `mountEdge: prefix "${prefix}" does not end with "/" -- the resulting baseUrl would ` +
        // biome-ignore lint/suspicious/noTemplateCurlyInString: quoting what a page writes, not interpolating.
        "not either, and every mesh call a page composes as `${baseUrl}${peerId}/...` would " +
        "run the two together into one segment the ServiceWorker cannot route, falling " +
        "through to the origin server. `BrowserPeerHandle.baseUrl` promises a trailing " +
        "slash (Ruling 58); this is what makes that promise keepable.",
    );
  }
}
