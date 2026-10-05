# @statewalker/httpeers-llm-chat

## What it is

A chat for any OpenAI-compatible API, as two static pages that share one chat
component (`ChatApp`). Private: built and published as a site, never to npm.

- **`index.html`** — the standalone chat. Point it at any OpenAI-compatible
  `baseUrl` (`https://api.openai.com/v1`, a local llama.cpp server, LiteLLM —
  anything that answers `GET {baseUrl}/models` and
  `POST {baseUrl}/chat/completions`) in the Connection panel. **It needs no
  mesh**: its bundle imports no httpeers package and registers no
  ServiceWorker.
- **`mesh.html`** — the same chat, joined to an httpeers mesh. It finds the
  mesh's hub, reads the hub's `openapi.json` for the LLM service it advertises,
  and configures the chat from that (`src/mesh/discover.ts`).

## Layout

| Path | What it is |
|---|---|
| `src/pages/standalone.tsx`, `src/pages/mesh.tsx` | the two entry points |
| `src/core/` | pure logic: config, `?config=` trust and parsing, the chat controller, the OpenAI client, IndexedDB stores |
| `src/ui/` | `ChatApp`, the settings dialog, the Connection and Models panels, primitives |
| `src/slots/` | the keyed-slot bus the settings dialog reads its tabs from |
| `src/mesh/` | everything mesh-specific: discovery, the join widget wrapper, the Sharing and Keys panels, the member-key dialog |
| `tests/` | Vitest unit and component tests (jsdom); `tests/e2e/` Playwright specs against the built pages |
| `scripts/` | `copy-assets.mjs` (prebuild), `fake-llm.mjs`, `smoke.mjs`, `mesh-smoke.mjs` |

Only `src/mesh/` and `src/pages/mesh.tsx` reach httpeers.

## How to run it

1. `pnpm --filter @statewalker/httpeers-llm-chat dev` — both pages, at
   `/index.html` and `/mesh.html`.
2. Open `/index.html`, enter a `baseUrl` (and a key if the endpoint needs one)
   in Settings → Connection, pick a model, chat.
3. `pnpm --filter @statewalker/httpeers-llm-chat build` — `dist/index.html` and
   `dist/mesh.html`, ready to publish as a static site.

Either page can be configured by link instead: `?config=<url>` names a JSON
document to fetch and apply on load (shape in [Reference](#reference)).

## Why it is the way it is

### The standalone page cannot reach the mesh, by construction

`tests/boundary.test.ts` walks the real import closures of
`pages/standalone.tsx` and `pages/mesh.tsx`, and fails if the standalone closure
reaches anything under `src/mesh/` or any `@statewalker/httpeers-*` package.
`tests/e2e/standalone.spec.mjs` checks the same at runtime: no ServiceWorker is
registered and the page talks to exactly two origins (the file server and the
endpoint).

### `?config=` is a first-boot mechanism, never an override

A config the user already saved always wins: `resolveConfig`
(`src/core/external-config.ts`) applies the document only when nothing is
saved. A link can hand someone an endpoint; it cannot silently replace one.

Before the document is fetched, `judgeConfigUrl` (`src/core/config-trust.ts`)
judges its URL:

- same origin as the page → applied without asking;
- on `mesh.html`, once a mesh edge is known, only **that edge's mount for the
  hub** (`<edge><hubPeerId>/llm/…`) is trusted. Same-origin is not enough there,
  because the edge serves every peer's mount side by side, and a sibling peer is
  not the hub;
- any other origin → **confirmed, not refused**. The document is fetched so
  `ConfirmConfigDialog` can name both the origin and the `baseUrl` that would
  receive messages and any key. Cancel is the default; Escape, an overlay click
  and Cancel all reject. Only "Use this configuration" accepts.

On `mesh.html`, discovery saves the hub's endpoint before `ChatApp` mounts, so a
`?config=` document can never redirect a joined chat away from its hub onto
another endpoint carrying the mesh's key header. `tests/chat-app.test.tsx` pins
this ("does not let a ?config= document override the endpoint discovered from
the hub").

### The settings dialog knows no panel

`src/ui/SettingsDialog.tsx` imports no panel. Every tab is a contribution to the
`@statewalker/shared-slots` keyed-slot bus: `ChatApp` registers Connection and
Models; on `mesh.html`, `registerMeshPanels` (`src/mesh/panels/index.tsx`) adds
Sharing and Keys to the same bus. No branch decides which tabs exist, and a
test enforces that the dialog never imports a panel.

```tsx
// src/slots/panels.ts
interface SettingsPanel {
  id: string;
  title: string;
  order: number;           // tabs sort by order, then title
  Component: ComponentType; // no props: read live state through a ref or closure
}

useEffect(() => {
  return slots.register(settingsPanelsSlot, "my-panel", {
    id: "my-panel",
    title: "My Panel",
    order: 50,
    Component: () => <MyPanelBody />,
  }); // the return value is the disposer
}, [slots]);
```

`useSlot(settingsPanelsSlot)` (`src/slots/context.tsx`) returns the panels as an
array and re-renders on every registration or disposal.

### A request has three phases, because "waiting" is not "hung"

`ChatState.phase` (`src/core/chat-controller.ts`) is `idle`, `waiting` or
`streaming`, and `isRunning` is derived from it (`phase !== "idle"`) so the two
cannot disagree. `waiting` — sent, nothing back yet — shows a placeholder with
an elapsed-seconds counter and Stop. Against a local model (a cold llama.cpp
load, a long prompt) the first token can take 30 seconds or more, and the
counter is what tells a person the request is working rather than hung.
`streaming` renders the partial reply in place of the placeholder.

## What will surprise you

- **A rejected `?config=` document is a notice, not a crash.** `schemaVersion`
  must be `1` and `baseUrl` a non-empty `http:` or `https:` URL; anything else
  is shown as a dismissible notice naming the problem.
- **`Slots#register` throws `RangeError`** when the same `id` is registered with
  a *different* value. The same value reference is ref-counted, so two
  consumers can register and dispose independently.
- **The ScrollArea `!important` rule is global.** `src/ui/styles.css` forces
  Radix's `ScrollArea` viewport wrapper to `display: block` for `ThreadList`. A
  second `ScrollArea` that wants natural-width sizing (a horizontally scrolling
  code block) would be defeated by it until the rule is scoped.
- **`tests/e2e/mesh.spec.mjs` needs a live appliance.** It finds one through
  `APPLIANCE_DIR` (the `deploy/llm-appliance` directory) or a guess; with none
  reachable it prints `mesh.spec: SKIPPED -- <reason>` and exits 0.
- **Pages bundle `httpeers-join` from its `dist/`.** After changing that
  package, rebuild it before building this app.

## Reference

### Commands

| Command | What it does |
|---|---|
| `pnpm --filter @statewalker/httpeers-llm-chat dev` | Vite dev server, both pages |
| `pnpm --filter @statewalker/httpeers-llm-chat build` | `dist/index.html`, `dist/mesh.html` |
| `pnpm --filter @statewalker/httpeers-llm-chat test` | Vitest: core, slots, every component (jsdom), the boundary test |
| `pnpm --filter @statewalker/httpeers-llm-chat typecheck` / `lint:check` | `tsc --noEmit`, Biome |
| `pnpm --filter @statewalker/httpeers-llm-chat e2e` | `tests/e2e/standalone.spec.mjs`: the built standalone page against a fake endpoint (needs `dist/`) |
| `node tests/e2e/responsive.spec.mjs` | the built page at 1280×800 and 390×844, asserting real layout boxes |
| `pnpm --filter @statewalker/httpeers-llm-chat mesh-smoke` | `tests/e2e/mesh.spec.mjs`: `mesh.html` against a real appliance — join, four tabs, mint a key, a streamed reply |
| `pnpm --filter @statewalker/httpeers-llm-chat smoke` | `scripts/smoke.mjs`: the standalone page against `scripts/fake-llm.mjs` |

The `node tests/e2e/…` and `node scripts/…` forms run from `apps/llm-chat`, after
a build.

### The `?config=` document

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
