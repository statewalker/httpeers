# @statewalker/httpeers-qr

Encoding and decoding as **pure functions** at the root, and a browser entry
that scans from a live camera.

```ts
import { qrSvg, decodeQr } from "@statewalker/httpeers-qr";

const svg = qrSvg(invitation);              // an inline SVG string
const text = decodeQr(imageData);           // string | null
```

The root touches no camera, no canvas and no DOM, so the same code renders an
invitation on a server and reads one in a page. `ImageData` satisfies `Pixels`
structurally, so a browser caller passes one straight through.

## Entry points

| Import | Holds | Needs |
|---|---|---|
| `.` | `qrSvg`, `qrModules`, `decodeQr`, `Pixels` | nothing — isomorphic |
| `./browser` | `scanFromCamera`, `scanFile`, `QrScan`, `CameraScan` | `html5-qrcode`, an **optional peer dependency** |

Nothing browser-only is reachable from the root, and
`tests/boundary.test.ts` measures that by **reachability** rather than by
exempting a filename: it walks the import closure of `index.ts` and fails if
`html5-qrcode` or a DOM global appears anywhere in it. Verified non-vacuous by
re-exporting the camera from the root and watching three named tests fail.

A consumer that only encodes never installs a camera library.

## What it encodes, and why that and nothing else

The bare invitation code — exactly the string the join field already accepts,
never a deep link. An invitation is not tied to a page: any page redeems any
code, and the hub never learns which origin its guests used. A QR carrying
`https://app.example/?join=…` would quietly reverse that.

Error correction level **M** (~15%), because a code that will be *photographed
off a screen* has to survive glare, moiré against the pixel grid, and a phone
held at an angle. L leaves nothing for that; Q and H push a 315-character
invitation to a denser grid, which photographs worse.

## Two decoders, and the split is about the camera

`decodeQr` (root, `jsqr`) takes pixels. `./browser` (`html5-qrcode`) takes a
camera or a file. Both ship, and the reason is not that one decodes better.

Measured over twelve manufactured degradations of a real 302-character join
blob, `jsqr` scored **8/12** against `html5-qrcode`'s **9/12**, the two
differing on heavy blur. That is close enough that decoder quality does not
decide anything. What decides it is the number of attempts:

- A **still frame gets exactly one**, and it has to survive whatever angle,
  blur, glare and white balance the phone produced. The first version of this
  feature was still-photo only and failed on real photographs — a screenshot
  decoded, a photo of the same screen did not.
- A **live camera gets dozens a second while the person watches the preview and
  adjusts.** That aiming feedback is what makes scanning work, and no file
  picker can offer it.

So the root exists to make still-image decoding possible *anywhere* — on a
server, in a worker, in a test — which the camera path cannot do at all; and
`./browser` exists because the camera is the path people actually use. The file
picker is kept there too, for a screenshot somebody sent and for a camera that
is refused or absent.

That evidence has a limit worth stating: the degradations are manufactured —
blur, rotation, perspective, JPEG artefacts, low contrast, glare, small
captures — because no photograph of a real invitation survives in the
repository. A folder of phone photos would be better evidence.

## The scanner does not know what an invitation is

`scanFromCamera` and `scanFile` take an `accept` callback that turns a decoded
string into whatever the caller was looking for, or `null`:

```ts
import { scanFromCamera } from "@statewalker/httpeers-qr/browser";
import { invitationFromQrText } from "@statewalker/httpeers-member";

const camera = await scanFromCamera(host, {
  accept: invitationFromQrText,
  onCode: (code) => session.join(code),
});
```

A QR package that knew the join format could not be used for anything else, so
`invitationFromQrText` lives in `@statewalker/httpeers-member`, which owns that
format. `accept` returning `null` is also what **keep scanning** means: a
scanner pointed at a wifi sticker or a poster must not stop on the first wrong
code, and must not hand that string to a hub.

Two details in `./browser` were expensive to learn and are commented where they
live. There is **no `qrbox`** — it is a crop, measured against the rendered
viewfinder rather than the camera's resolution, and it cut QR codes that filled
the frame. And a camera that cannot start **rejects** rather than resolving
quietly, because that is exactly when the caller should offer the file picker.

## The test is a round trip

`tests/round-trip.test.ts` encodes a real join blob, rasterises the module
matrix, decodes the pixels, and compares. The two halves check each other in
Node, with nothing browser-shaped in the path — which is the root's claim,
stated as something that can fail.

`./browser` is not exercised here: it needs a camera and a DOM. What IS checked
without one is that it stays out of the root's import closure (above), and that
`@statewalker/httpeers-qr/browser` resolves for a consumer — the latter in
`httpeers-conformance`, which compiles every published entry point the way a
dependent does.

**21 tests.**
