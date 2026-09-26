# llm-chat

A chat for any OpenAI-compatible API. Two pages, one chat (`ChatApp`) reused unchanged between them.

## The two pages

- **`index.html`** — the standalone chat. Point it at any OpenAI-compatible `baseUrl`
  (`https://api.openai.com/v1`, a local llama.cpp server, LiteLLM, whatever answers
  `GET {baseUrl}/models` and `POST {baseUrl}/chat/completions`) by typing it into the Connection
  panel. **It needs no mesh.** Its bundle imports no httpeers package and registers no
  ServiceWorker — `tests/boundary.test.ts` proves the former by walking the page's actual import
  closure, `tests/e2e/standalone.spec.mjs` the latter by watching what a real browser does.
- **`mesh.html`** — the same chat, joined to an httpeers mesh. It finds the mesh's hub, reads the
  hub's own `openapi.json` for the LLM service it advertises, and configures the chat from that —
  see `src/mesh/discover.ts`. Everything mesh-specific lives under `src/mesh/` and in
  `src/pages/mesh.tsx`; nothing else in the app reaches httpeers.

```sh
pnpm run dev          # both pages, at /index.html and /mesh.html
pnpm run build         # dist/index.html, dist/mesh.html
```

## `?config=<url>`

Either page can be pointed at an endpoint by URL instead of typing it in: `?config=<url>` names a
JSON document to fetch and apply on load.

**The document's shape** (`src/core/external-config.ts`):

```json
{
  "schemaVersion": 1,
  "baseUrl": "https://hub.example/v1",
  "apiKey": "optional",
  "apiKeyHeader": "optional, e.g. x-litellm-api-key",
  "defaultModel": "optional",
  "label": "optional, not currently displayed"
}
```

`schemaVersion` must be `1`; `baseUrl` must be a non-empty `http:`/`https:` URL. Anything else in
the document is rejected with a specific error (shown as a dismissible notice, never a crash).

**Resolution order.** A config already saved by the user always wins over the fetched document —
`resolveConfig` in `src/core/external-config.ts` applies the document only when there is nothing
saved yet. This is deliberate: a `?config=` link is a first-boot / hand-a-link mechanism, not a
standing override, so it can never silently replace an endpoint the user (or the mesh page's own
discovery — see below) already set.

**The trust rule** (`src/core/config-trust.ts`, `judgeConfigUrl`). Before the document is even
fetched, the URL is judged:

- same origin as the page → trusted, fetched and applied without asking;
- on `mesh.html`, once a mesh edge is known, the trusted set narrows to that **specific edge's
  mount** (`<edge><hubPeerId>/llm/…`) — plain same-origin is no longer enough, because the edge's
  host serves every peer's mount side by side (`<host>/peers/<peerId>/…`), and "same origin" would
  also cover a sibling peer's mount, exactly the "another peer is not your hub" case
  `discover.ts`'s own trust rule guards against;
- anything else — a foreign origin — is **confirmed, not refused**: the document is still fetched
  (so the dialog can name the endpoint it wants, not just its origin) and `ConfirmConfigDialog` is
  shown, naming both the origin and the `baseUrl` it wants to send messages and any key to. Cancel
  is the default focused action; Escape, an overlay click and Cancel all reject alike. Only the
  explicit "Use this configuration" button accepts.

**On `mesh.html`, the discovered endpoint takes precedence by design.** `mesh.tsx`'s own discovery
saves the endpoint it read from the hub's advertisement *before* `ChatApp` ever mounts, so by the
time a `?config=` document (if any) is handled, "saved wins" above means it never overrides what
discovery just set. This is not incidental: a URL parameter that could redirect the chat away from
the hub it just joined, onto an attacker's endpoint carrying the mesh's own key header, is exactly
the substitution `discover.ts`'s "trust only the hub" rule exists to prevent. `?config=` is a
first-boot mechanism for the **standalone** page; see `tests/chat-app.test.tsx`'s "does not let a
?config= document override the endpoint discovered from the hub" for the pinned behaviour.

## The settings dialog and slots

There is one settings dialog (`src/ui/SettingsDialog.tsx`), and it imports no panel — it knows
nothing about connections, models, or the mesh. Every tab it shows is a **contribution**, made
through `@statewalker/shared-slots`' keyed-slot bus: `ChatApp` registers Connection and Models on
mount; on `mesh.html`, `registerMeshPanels` (`src/mesh/panels/index.tsx`) additionally registers
Sharing and Keys into the *same* bus, so the mesh page's dialog shows all four tabs with no branch
anywhere deciding which. `tests/boundary.test.ts` and a source check both enforce that the dialog
itself never imports a panel — if a task needs the dialog to know about a panel by name, the slot
is being worked around.

**The `SettingsPanel` shape** (`src/slots/panels.ts`):

```ts
interface SettingsPanel {
  id: string;
  title: string;
  order: number;
  Component: ComponentType; // no props — read live state through a ref/closure, not props
}
```

Panels are ordered by `order`, then by `title` (`orderPanels`).

**Contributing a panel**, the same way `ChatApp.tsx` registers its own:

```tsx
useEffect(() => {
  const dispose = slots.register(settingsPanelsSlot, "my-panel", {
    id: "my-panel",
    title: "My Panel",
    order: 50,
    Component: () => <MyPanelBody />,
  });
  return dispose;
}, [slots]);
```

`Slots#register` takes **three** arguments — `register(decl, id, value)` — and there is no
`unregister`; the call's own return value is the disposer. Re-registering the same `id` with a
*different* value throws `RangeError`; with the *same* value reference it is ref-counted, so two
consumers can register-and-dispose independently without one tearing down the other's tab.

Reading the panels back: `slots.getSnapshot(settingsPanelsSlot)` returns a `ReadonlyMap<string,
SettingsPanel>` (keyed by `id`), not an array. Components don't call `getSnapshot` directly —
`useSlot(settingsPanelsSlot)` (`src/slots/context.tsx`) wraps it in `useSyncExternalStore` and
hands back a plain **array**, re-rendering on every registration or disposal, including one that
lands mid-render.

## The three run phases

`ChatState.phase` (`src/core/chat-controller.ts`) is one of three values, and `isRunning` is
**derived** from it (`phase !== "idle"`) rather than tracked separately — two fields that could
disagree about whether a request is in flight would eventually disagree:

- **`idle`** — nothing in flight. No indicator, no Stop button.
- **`waiting`** — a request has been sent and nothing has come back yet. A placeholder bubble with
  an elapsed-seconds counter, and Stop.
- **`streaming`** — at least one delta has arrived; the partial reply renders in place of the
  placeholder, Stop stays.

**Why `waiting` exists as its own phase, distinct from `streaming`:** against a local model (cold
llama.cpp load, prompt processing on a big context) it can legitimately run 30 seconds or more
before the first token arrives. A single "is it running?" spinner cannot tell that apart from a
hung request — the user has no way to know whether to keep waiting or give up. The elapsed-seconds
counter in the `waiting` bubble is what answers that: it tells a human "this is working," not "this
hung," and it is the reason `phase` carries three states instead of a boolean.

## Running the tests

```sh
pnpm test                              # vitest — unit + component tests, jsdom
pnpm run typecheck                     # tsc --noEmit
pnpm run lint:check                    # biome check (biome.json extends the repo's own)
```

Vitest covers everything that doesn't need a real browser: the pure core (`config.ts`,
`config-trust.ts`, `external-config.ts`, `chat-controller.ts`), the slots bus, and every component
(`@testing-library/react` + jsdom). It also runs `tests/boundary.test.ts`, which walks the actual
import closures from `pages/standalone.tsx` and `pages/mesh.tsx` and fails if the standalone page's
closure ever reaches anything under `src/mesh/` or imports `@statewalker/httpeers-*`.

Three more layers run against a **real browser** (Playwright/Chromium) and the **built** app —
jsdom has no layout engine and no real ServiceWorker, so none of the following can be proven there:

```sh
pnpm run build                                # all three specs below need dist/
node tests/e2e/standalone.spec.mjs             # or: pnpm run e2e
node tests/e2e/responsive.spec.mjs
node tests/e2e/mesh.spec.mjs                   # or: pnpm run mesh-smoke
```

- **`tests/e2e/standalone.spec.mjs`** — `dist/index.html` against a fake OpenAI-compatible
  endpoint. Proves the standalone page reaches for nothing mesh-related at runtime either: it
  asserts no ServiceWorker is ever registered and that the whole run talks to exactly two origins
  (the static file server and the fake endpoint).
- **`tests/e2e/responsive.spec.mjs`** — `dist/index.html` at two real viewports (1280×800 and
  390×844), ten assertions, every one reading `boundingBox()`/`isVisible()` — never a class name —
  because a class like `md:hidden` is not a layout assertion. Covers the sidebar/Sheet breakpoint,
  the composer staying on screen (including after focus, for the on-screen-keyboard case), no
  horizontal scroll, and the settings dialog staying fully on screen with every tab reachable at
  both sizes.
- **`tests/e2e/mesh.spec.mjs`** — `dist/mesh.html` against a **real httpeers appliance**: joins by
  pasting an invitation blob, confirms all four settings tabs appear, mints a key from the Keys
  panel, sends a message and waits for a genuinely streamed reply (partial text observed before the
  final one). **It needs a live appliance and skips cleanly without one** — see the file's own
  header for how to start one (`deploy/llm-appliance` in an httpeers checkout) and how the script
  finds it (`APPLIANCE_DIR`, or a guessed sibling worktree). If no appliance is reachable, minting
  the spec's own invitation fails and the script prints `mesh.spec: SKIPPED -- <reason>` and exits
  `0` — a missing appliance is not a failure of this code, so it is never reported as one.

## Known gaps

- **`src/mesh/member-key.tsx`** (the "Key for a member" dialog an admin uses to mint a key for
  someone else) had no test file of its own before this task — it was covered only by `typecheck`
  and `build`, and transitively by `tests/e2e/mesh.spec.mjs`, which exercises the sibling "Request
  a key" flow but never this dialog's own accessible name or close path. Closed rather than
  recorded: `tests/member-key.test.tsx` now covers both (the dialog opens with an accessible name,
  and Escape closes it back to the trigger) — cheap to add given every other dialog in this app
  already has the same coverage as a pattern to copy, and `mintKey`/`keyShareText` themselves are
  already unit-tested in `tests/discover.test.ts`, so this was the missing piece, not a new one.
- **The `!important` override** in `src/ui/styles.css`, forcing Radix's `ScrollArea` Viewport
  wrapper to `display: block`, is global and currently has exactly one consumer (`ThreadList`'s
  session list). If a second `ScrollArea` consumer is added that actually *wants* the wrapper's
  natural-width sizing — a horizontally scrolling code block, say — this rule would silently defeat
  it for that consumer too, since it is not scoped to `ThreadList`. Noted in the CSS itself; scoping
  it (e.g. to a `ThreadList`-specific class) is future work for whoever adds that second consumer.
