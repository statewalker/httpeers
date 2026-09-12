# @statewalker/httpeers-qr

QR encoding and decoding as **pure functions**. A string in, an SVG out;
pixels in, a string out.

```ts
import { qrSvg, decodeQr } from "@statewalker/httpeers-qr";

const svg = qrSvg(invitation);              // an inline SVG string
const text = decodeQr(imageData);           // string | null
```

Neither half touches a camera, a canvas or the DOM, so the same code renders
an invitation on a server and reads one in a page. `ImageData` satisfies
`Pixels` structurally, so a browser caller passes one straight through.

## What it encodes, and why that and nothing else

The bare invitation code — exactly the string the join field already accepts,
never a deep link. An invitation is not tied to a page: any page redeems any
code, and the hub never learns which origin its guests used. A QR carrying
`https://app.example/?join=…` would quietly reverse that.

Error correction level **M** (~15%), because a code that will be *photographed
off a screen* has to survive glare, moiré against the pixel grid, and a phone
held at an angle. L leaves nothing for that; Q and H push a 315-character
invitation to a denser grid, which photographs worse.

## What is NOT here: the camera

`decodeQr` works on still pixels. The live camera loop stays in the
application, on `html5-qrcode`, and this package does not replace it.

Measured over twelve manufactured degradations of a real 302-character join
blob, `jsqr` scored **8/12** against the incumbent's **9/12**, the two
differing on heavy blur. So this is **additive**: it makes still-image decoding
possible everywhere, which the incumbent cannot do at all, and it does not
claim to beat the incumbent at the camera's job.

That evidence has a limit worth stating: the degradations are manufactured —
blur, rotation, perspective, JPEG artefacts, low contrast, glare, small
captures — because no photograph of a real invitation survives in the
repository. A folder of phone photos would be better evidence, and the
prototype that produced these scores accepts one.

## The test is a round trip

`tests/round-trip.test.ts` encodes a real join blob, rasterises the module
matrix, decodes the pixels, and compares. The two halves check each other in
Node, with nothing browser-shaped in the path — which is the package's claim,
stated as something that can fail.
