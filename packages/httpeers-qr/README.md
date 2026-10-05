# @statewalker/httpeers-qr

## What it is

QR codes for httpeers invitations. The root encodes a string to an SVG or a
module matrix and decodes pixels back to a string, as pure functions. The
`./browser` entry scans from a live camera or a picture file.

## Why it exists

An invitation is a long string (around 300 characters as a join blob), and the
way people move it between devices is a phone camera pointed at a screen. That
needs an encoder tuned to be photographed, a decoder that runs anywhere (on a
server, in a worker, in a test), and a live camera scanner. The encoder and the
pure decoder must not pull a camera library into every consumer, so the camera
lives behind its own entry point.

## How to use

```sh
pnpm add @statewalker/httpeers-qr
pnpm add html5-qrcode    # only if you use ./browser
```

| Import | Gives | Needs |
|---|---|---|
| `.` | `qrSvg`, `qrModules`, `decodeQr`, the `Pixels` type | nothing — isomorphic |
| `./browser` | `scanFromCamera`, `scanFile`, the `QrScan` and `CameraScan` types | `html5-qrcode`, an **optional peer dependency**; a DOM |

## Examples

Encode and decode:

```ts
import { decodeQr, qrSvg } from "@statewalker/httpeers-qr";

const svg = qrSvg(invitation);       // an inline SVG string
const text = decodeQr(imageData);    // string | null; ImageData satisfies Pixels
```

Scan from the camera until an invitation appears:

```ts
import { scanFromCamera } from "@statewalker/httpeers-qr/browser";
import { invitationFromQrText } from "@statewalker/httpeers-member";

const camera = await scanFromCamera({ id: "scanner" }, {   // id of a host element
  accept: invitationFromQrText,      // string -> invitation, or null to keep scanning
  onCode: (code) => session.join(code),
});
// later: await camera.stop();
```

Scan a picture file:

```ts
import { scanFile } from "@statewalker/httpeers-qr/browser";

const result = await scanFile(file, { accept: invitationFromQrText });
if (result.ok) await session.join(result.value);
else if (result.reason === "no-qr") showHint("No QR code found in that picture.");
else showHint(`That QR code is not an invitation: ${result.text}`);
```

## Internals

### It encodes the bare invitation, never a deep link

The QR carries exactly the string the join field accepts. An invitation is not
tied to a page: any page redeems any code, and the hub never learns which
origin its guests used. A QR carrying `https://app.example/?join=…` would tie
the two together.

### Error correction is M because the code is photographed off a screen

Level **M** (~15%) survives glare, moiré against the pixel grid and a phone
held at an angle. L leaves no margin for that; Q and H push a 300-character
invitation to a denser grid, which photographs worse.

### Two decoders, because the camera gets many attempts and a photo gets one

`decodeQr` (root, `jsqr`) takes pixels; `./browser` (`html5-qrcode`) takes a
camera or a file. Over twelve manufactured degradations of a real
302-character join blob (blur, rotation, perspective, JPEG artefacts, low
contrast, glare, small captures), `jsqr` decoded 8 and `html5-qrcode` 9,
differing on heavy blur. Decoder quality does not decide anything. The number
of attempts does:

- a **still photo gets one attempt** and must survive whatever the phone
  produced — a screenshot decodes, a photo of the same screen often does not;
- a **live camera gets dozens a second** while the person watches the preview
  and adjusts, and that feedback is what makes scanning work.

So the root makes still-image decoding possible anywhere, and `./browser` holds
the camera, which is the path people use. The file picker stays in `./browser`
for a screenshot someone sent and for a camera that is refused or absent.

### The scanner does not know what an invitation is

`accept` turns a decoded string into what the caller wants, or `null`.
Returning `null` means **keep scanning**: a camera pointed at a wifi sticker
must not stop on the first wrong code, and must not hand that string to a hub.
`invitationFromQrText` lives in `@statewalker/httpeers-member`, which owns the
join format.

### Two camera details that look like bugs

- **No `qrbox`.** In `html5-qrcode` it is a crop measured against the rendered
  viewfinder, not the camera's resolution, and it cuts off QR codes that fill
  the frame.
- **A camera that cannot start rejects** rather than resolving quietly, because
  that is when the caller should offer the file picker.

### The root never reaches the camera

`tests/boundary.test.ts` walks the import closure of `index.ts` and fails if
`html5-qrcode` or a DOM global appears in it. A consumer that only encodes never
installs a camera library.

### Dependencies

`qrcode-generator` (encoding) and `jsqr` (decoding) at the root;
`html5-qrcode` as an optional peer for `./browser`.

Tests: `pnpm --filter @statewalker/httpeers-qr test`. `tests/round-trip.test.ts`
encodes a real join blob, rasterises the module matrix, decodes the pixels and
compares, all in Node. `./browser` needs a camera and a DOM and is not exercised
here; `httpeers-conformance` checks that the subpath resolves for a consumer.

## License

MIT
