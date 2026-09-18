# @statewalker/httpeers-join

The **join-the-mesh widget**: one small piece of plain DOM that every page joining
an httpeers hub shows the same way.

- **Paste** an invitation (a join link, a join blob, or a bare invitation id), which calls
  `session.join(text)`.
- **Scan** a QR code with the live camera, or from a picture on the device. The decoded text
  becomes an invitation through `invitationFromQrText` from `@statewalker/httpeers-member`.
- **See the link to the hub**: the phase (`checking`, `starting` with its peer state, `live`,
  `needs-invitation`, `disconnected`, `blocked`, `failed`), whether a live link is `relay` or
  `direct`, and this page's own peer id, shortened.
- **See what went wrong**: the phase's own message, and any call that rejected.
- **Leave**: Disconnect (keeps membership), Reconnect, and "Leave this mesh…"
  (`session.resetIdentity()`, which forgets the identity), behind a confirmation.
- **Invite** (mesh admins only): make an invitation as a member or an admin, valid for 1 hour,
  1 day or 7 days, and hand it over as a link, a QR code, the share sheet or the clipboard. See
  [Invite](#invite).

Every button is shown only when `SessionState.controls` allows it. There is one addition: "Leave"
is hidden while there is no identity (a first run has nothing to forget). The widget decides
nothing else about the session: `PeerSession` already decides it, and the widget shows the
result.

```ts
import { mountJoinWidget } from "@statewalker/httpeers-join";
import { createSession } from "@statewalker/httpeers-member/browser";

let widget;
const session = createSession({ /* … */, onChange: (state) => widget?.update(state) });
widget = mountJoinWidget(document.querySelector("#mesh-join")!, {
  session,
  state: session.state(),
});
await session.start();
```

## API

| Export | What it is |
|---|---|
| `mountJoinWidget(container, options) → JoinWidget` | Builds the widget inside `container`. |
| `JoinWidget.update(state)` | Show a new `SessionState` (or `null`: "Starting…"). Call it from `onChange`. |
| `JoinWidget.destroy()` | Stops a running camera and removes the widget. |
| `JoinWidget.element` | The widget's root element. |
| `describePhase(state)` | The status line's text, for a page that wants it elsewhere. |
| `shortPeerId(id)` | `12D3KooWAb…abcdef`. |
| `defaultQrScanner()` | The real `QrScanner` (see below). |
| `JOIN_WIDGET_CSS`, `injectJoinWidgetStyles(doc)` | The stylesheet, for a page that injects it itself. |
| `LEAVE_CONFIRMATION` | The text "Leave this mesh…" asks before it acts. |
| `createHubAdminClient(fetch, apiBase)` | The hub's admin API (`roles`, `create`, `pending`), for a page that builds its own invite UI. |
| `hubAdminBase(target)`, `adminHint(target)` | `<baseUrl><hubPeerId>/hub/api/`, and whether the mesh view makes this member a likely admin. |
| `INVITE_ROLES`, `INVITE_EXPIRIES`, `expiryMs(id)`, `invitationRequestBody(role, ttlMs)`, `offeredRoles(hubRoles)` | The panel's choices and the request it sends. |
| `ADMIN_INVITATION_WARNING` | The warning shown while "Admin" is selected. |
| `createInvitePanel(doc, make, n, options)` | The panel on its own. The widget builds it; a page rarely needs to. |

`JoinWidgetOptions`:

| Option | Default | |
|---|---|---|
| `session` | required | Anything with `join`, `disconnect`, `reconnect` and `resetIdentity`. A `PeerSession` is one. |
| `state` | `null` | The state to show at once, usually `session.state()`. |
| `compact` | `false` | One status line, plus a "Mesh" menu with Disconnect, Leave and, for an admin, Invite. No join form. For a header. |
| `scanner` | `defaultQrScanner()` | `null` hides both QR buttons. |
| `confirm` | `window.confirm` | Asked before leaving. May return a promise, for a page with its own dialog. |
| `injectStyles` | `true` | `false` leaves styling to the page. The `hp-join-` and `hp-invite-` class names are then the API. |
| `invite` | `{}` | The Invite panel's options (`fetch`, `share`, `copy`, `qrSvg`, `now`, `retryDelayMs`, `roleAttempts`), or `false` to leave the panel out. |

The state passed to `update()` may carry `handle` (a `SessionState` does). The widget reads only
its `hubPeerId`, `baseUrl` and `meshView()`, and only for the Invite panel.

**QR.** `defaultQrScanner()` loads `@statewalker/httpeers-qr/browser` (and with it
`html5-qrcode`) with a dynamic `import()` on the **first scan**, so a page that only resumes
never downloads the camera library, and a bundler gives it a chunk of its own. The camera button
is hidden when `navigator.mediaDevices.getUserMedia` is missing, which covers an insecure origin
and a browser with no camera API. The picture button stays. A camera that exists but is refused
is reported when the button is pressed, with a pointer to the picture button. A scan that finds a
QR code that is not an invitation keeps scanning (camera) or says so (picture). A bare invitation
id is not accepted from a QR code: nothing tells it apart from any other short string.

**A picture gets two decoders.** html5-qrcode's `scanFile` could not read the demos hub's own
invitation QR (a 310-character join blob) from a clean 684 px screenshot, nor at 600 or 480 px.
It read the same picture at 400 px and below. Phone screenshots and photos are larger than that.
When html5-qrcode finds nothing, `defaultQrScanner` therefore draws the picture to a canvas at
its own size (capped at 1600 px), then at 800 and 400 px, and runs `decodeQr` (jsQR, from the
`@statewalker/httpeers-qr` root, also loaded lazily) on each. Measured in Chromium with the
built demos app, every size from 300 to 3000 px decodes, as does a blurred, tilted and darkened
3000 px copy. The same run, scanning the hub page's real QR code, joined its mesh live. The
camera path is html5-qrcode alone. It gets many frames and the person aims it.

**Accessibility.** The status line is `role="status"`. The phase message is `role="alert"` when it
reports trouble (a hub that does not know this peer, a refused invitation, `blocked`, `failed`) and
`role="status"` when it gives instructions (a first run, `disconnected`, a live note). A rejected
call and a failed scan go to a separate `role="alert"` line. The field has a `<label>`, every
control is a `<button>` (or a labelled file input), and ids are unique per instance.

**Styling.** The widget injects one `<style id="hp-join-style">` per document on its first mount.
Every rule is on an `hp-join-` or `hp-invite-` class, and none is in a cascade layer, so the rules beat
Tailwind's preflight (`@layer base`) without leaking into the page. Colours are custom properties
on `.hp-join` (`--hp-join-accent`, `--hp-join-danger`, `--hp-join-bg`, …). The widget inherits
the page's font.

### Invite

A mesh admin gets an **Invite someone** section: below the controls in the full widget, and in
the "Mesh" menu in the compact one. It holds:

- **Invite as**: Member (the default) or Admin. While Admin is selected, a warning says that an
  admin invitation grants full control of the mesh: whoever redeems it can invite others (admins
  too), revoke members, and use every admin service the hub offers. The Create button turns red
  and says "Create admin invitation".
- **Expiry**: 1 hour, 1 day (the default, and the hub's own default) or 7 days.
- **Create**: `POST /hub/api/invitations {"roles": [role], "ttlMs": …}`. The hub answers with
  `link`, its ready join URL (its `HUB_JOIN_PAGE_URL` plus `?join=`), and the panel shows it with
  its QR code, a note saying who may join as what until when, **Share** (`navigator.share`,
  hidden where the browser has none, so on most desktops) and **Copy link** (the Clipboard API,
  or selecting the link and `execCommand("copy")`).
- **Pending invitations**: `GET /hub/api/invitations`, loaded when the section is opened and after
  each Create, with **Refresh**. Each shows its role and how long it has left. Expired ones are
  left out. Every admin's invitations are listed, including those made through the door.

A failed call is shown inline, as `role="alert"`, and the panel stays usable.

**Who sees it.** The calls go where every call to the hub goes: `fetch` to
`<baseUrl><hubPeerId>/hub/api/…`, which the page's ServiceWorker edge routes over the mesh with
this member's token (llm-chat requests an LLM key the same way). The hub serves its admin API
there behind `std:mesh.admin`, which its rules give to `role("admin")`. The panel therefore
stays hidden until all three hold:

1. the page is live;
2. the mesh view lists this member with the `admin` role (`adminHint`). This is only a hint,
   and it decides whether the hub is asked at all. Asking every member would put a refused
   request, which browsers print as a console error, on every member's page on every link;
3. `GET /hub/api/roles` succeeds. This is the actual check. A 403 (the hub says not an admin),
   404 (a hub with no admin API, such as the demos' browser-tab hub) or 401 hides the panel for
   the life of that link. A network error or a 5xx is tried up to three times, 2 s apart.

The roles call also fills the picker: Member and Admin are offered only if the hub knows them.
Other roles the hub knows are **not** offered. The appliance's rules also define `hidden` (a
member the mesh view hides from non-admins), which is a tool for operators and has no place in a
two-button picker. Mint it through the door when needed. Nothing is asked again until the link
changes (a disconnect, a reconnect, another hub).

**An invitation is a bearer secret.** It redeems once, for whoever holds it. Nothing in the
panel logs one. The pending list shows no invitation ids (a bare id redeems too). The link and
QR code are cleared when the page leaves `live`. Error messages quote only the hub's `{ error }`
text, which never carries an invitation.

**The QR code** is `qrSvg` from `@statewalker/httpeers-qr`, loaded on the first Create like the
scanner. It encodes the hub's `link`, not the bare blob, so a phone's own camera app opens the
join page directly. The widget's scanner accepts the same link.

**On a phone**, below 30rem, the compact widget's menu becomes a sheet along the bottom of the
screen (at most 70% of its height, scrolling), because anchored to its button it ran off the
left edge. The header, and the toggle that closes the menu, stay in view.

### In React

The widget is not a React component, and React pages wrap it in a few lines. The session and the
state stay in React. The widget is mounted once and fed each state:

```tsx
function JoinWidgetView({ session, state, compact }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const widget = useRef<JoinWidget | null>(null);
  useEffect(() => {
    if (host.current == null) return;
    const w = mountJoinWidget(host.current, { session, compact });
    widget.current = w;
    return () => { w.destroy(); widget.current = null; };
  }, [session, compact]);
  useEffect(() => widget.current?.update(state), [state]);
  return <div ref={host} />;
}
```

`apps/llm-chat/src/mesh/join-widget.tsx` is this wrapper. It lives in `mesh/` because the
boundary test keeps httpeers out of everything the standalone page reaches.

## Design

**What had to be shared.** Four pages join a hub: llm-chat's `mesh.html` (React and Tailwind)
and the demos' `app`, `images` and `proxy` pages (plain DOM). Each had its own copy of the join
form and the Disconnect/Reconnect buttons. None of them offered QR scanning or a way to leave, and
the copies had already drifted in wording.

**Three shapes were considered.**

1. **A React component, with a DOM copy for the demos.** Rejected. That keeps two copies, which is
   the problem this package solves, and the demos would take on a framework to show one form.
2. **A custom element (`<httpeers-join>`).** Close. It works in both worlds and needs no wrapper.
   But it registers a global name once per page, which clashes when two bundles on one origin each
   ship a copy. Its state goes in through a property that React 19 sets but earlier versions do
   not. Its lifecycle (`connectedCallback`, upgrade order) is harder to test than a function call.
   None of this buys anything a function does not.
3. **A function that mounts into a container and returns `{ update, destroy }`.** Chosen. It is
   plain TypeScript and DOM, has no globals and no registration, and is straightforward to test
   under happy-dom with a fake session. React wraps it in about ten lines, and a plain page calls
   it directly.

**The widget holds no session state.** The session reports changes through one `onChange` that
the page wires up when it creates it. The page therefore owns the session and passes each
state to `update()`. The widget keeps only what exists only on screen: the typed text, a running
camera, a button whose call is in flight, and the last rejection.

**Where it lives.** It is a new package rather than an entry in `@statewalker/httpeers-member`
(`/join-widget`), for two reasons:

- `httpeers-member` compiles without the DOM lib on purpose (see its `tsconfig.json`), and its
  boundary test keeps DOM out of everything the root reaches. A widget is DOM from top to bottom.
  As an entry there it would need either the DOM lib for the whole package or a set of local
  declarations the size of the widget.
- The widget depends on `httpeers-qr/browser` and `html5-qrcode`. Putting it in `httpeers-member`
  would make the member package depend on the QR package, for a camera most members never use.

`httpeers-join` depends on `httpeers-member` (the types and `invitationFromQrText`) and
`httpeers-qr`, and nothing in `packages/` depends on it except the private conformance leaf. Apps
never import from other apps, so a package is the only place both apps can share it from.

**Nothing happens at import.** The widget touches no `document`, `window` or stylesheet until
`mountJoinWidget` runs, and the camera library is loaded by the first scan.
`tests/import.test.ts` imports the built `dist/` under plain Node to check both.
`httpeers-conformance`'s `runtime-import.test.ts` imports the entry again, together with every
other published entry.

## The `dist/` trap

The apps' Vite configs set no `resolve.conditions`, and this package's `exports` map offers no
`source` condition. **Pages bundle `dist/`**, which is gitignored and holds whatever was last
built. After changing `src/`:

```sh
pnpm --filter @statewalker/httpeers-join build     # or: pnpm turbo build
pnpm --filter @statewalker/httpeers-llm-chat build # and/or the demos
```

Then check that the page's bundle hash changed. If it did not, the change did not reach the
bundle. `turbo build` builds this package before the apps because they depend on it.

## Tests

```sh
pnpm --filter @statewalker/httpeers-join test   # build, typecheck, vitest
```

- `tests/widget.test.ts` (happy-dom): a fake session is taken through every phase. The tests
  check the status text, the message and its role, which buttons show, that each button calls
  the right session method (and is disabled while the call runs), the confirmation before
  leaving, a rejected call shown as an alert, camera and picture scanning through a fake scanner
  (including the camera stopping when the form goes away), compact mode, and unique ids per
  instance.
- `tests/invite.test.ts` (happy-dom): the panel's decisions (expiry mapping, the request body
  for member and admin, the roles offered, the API address, the admin hint, which failures are
  final), the client (the POST it sends, a 403, an unreachable hub), and the panel inside the
  widget against a fake hub. The fake hub checks that nothing is asked until live and until the
  view says admin, that a 403 or 404 hides the panel with no second request, that a 502 is
  retried, the admin warning, the link and QR code, Share and Copy, a refused Create shown
  inline, and the pending list (roles and time left, never ids). It also checks that the link is
  cleared on leaving `live`, that the panel sits in the compact menu, and that nothing is logged.
- `tests/import.test.ts` (Node, no DOM): the built entry imports and exports the widget, and the
  camera library is loaded only by a dynamic `import()`.

Nothing here drives a real camera or a real hub. That is covered by the apps' Playwright smokes
(`apps/demos/scripts/join-smoke.mjs`, `apps/llm-chat/scripts/mesh-smoke.mjs`), which join through
this widget.
