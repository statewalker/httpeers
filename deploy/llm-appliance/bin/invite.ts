/**
 * Mints an invitation through the local door, blob-first, and writes it out
 * as three artifacts: `blob.txt` (the credential itself -- the primary
 * artifact), `blob.png` (a QR of that SAME blob, not of the link) and
 * `link.txt` (one convenience way to spend it). `bin/invite.sh` runs this
 * inside a stock `node:22-alpine`, on the host's network, with the repo
 * bind-mounted -- see that script for why.
 *
 * THE BLOB IS THE CREDENTIAL; THE LINK IS NOT. `../../../packages/httpeers-
 * member/src/join-blob.ts`'s `readJoinInputFromText` already accepts a bare
 * blob, a bare invitation id, or a whole URL -- nothing here needed to
 * change for that to be true. This script exists only to mint one, verify
 * the two things that can silently make an invitation useless (a blob the
 * widget rejects, a QR nobody can scan back), and hand over the result.
 *
 * CONFIGURATION COMES ENTIRELY FROM ENVIRONMENT VARIABLES, set by
 * `bin/invite.sh` from `.env` and `data/hub/hub.env` -- this file parses no
 * argv, so it stays a plain function of its inputs and is easy to reason
 * about in isolation.
 *
 * THE PNG ENCODER/DECODER BELOW ARE HAND-ROLLED, ON PURPOSE. The only
 * dependency this script needs beyond the repo's own `httpeers-qr` is a way
 * to turn a module matrix into an actual `.png` file and back -- and a real
 * image library (sharp, canvas) means either a native binary that may not
 * exist for `node:22-alpine`'s libc, or a devDependency `httpeers-qr` never
 * asked this script to carry. A `qrModules()` matrix rasterised as 8-bit
 * RGBA, filter type "None", no interlacing, is one of the simplest valid PNG
 * documents there is -- IHDR/IDAT/IEND, `node:zlib` for the one compressed
 * chunk. This is round-tripped against itself in `main()` below, not merely
 * assumed to work.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { deflateSync, inflateSync } from "node:zlib";
import { readJoinInputFromText } from "../../../packages/httpeers-member/src/join-blob.ts";
import { decodeQr, type Pixels } from "../../../packages/httpeers-qr/src/decode.ts";
import { qrModules } from "../../../packages/httpeers-qr/src/encode.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value == null || value === "") {
    throw new Error(`invite: missing required environment variable ${name}`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// A minimal PNG codec: 8-bit RGBA, no interlace, filter type "None" only.
// Just enough to write `blob.png` and read it back for the round-trip check.
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/** The standard PNG/zlib CRC-32, computed bit by bit -- chunks here are a few KB at most, so a lookup table would only add code, not speed. */
function crc32(buf: Buffer): number {
  let crc = ~0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, "ascii");
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * Rasterises a QR module matrix (as `qrModules` returns it) into an RGBA
 * PNG: one solid `scale x scale` block per module, plus a quiet-zone margin
 * of `quietZone` modules -- mirroring `encode.ts`'s own `qrSvg` (4 modules,
 * the spec's minimum, without which many decoders never find the finder
 * patterns).
 */
function qrPng(modules: boolean[][], scale = 8, quietZone = 4): Buffer {
  const n = modules.length;
  const size = (n + quietZone * 2) * scale;
  const stride = size * 4;
  const raw = Buffer.alloc((stride + 1) * size);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    const my = Math.floor(y / scale) - quietZone;
    for (let x = 0; x < size; x++) {
      const mx = Math.floor(x / scale) - quietZone;
      const dark = my >= 0 && my < n && mx >= 0 && mx < n && modules[my]?.[mx] === true;
      const value = dark ? 0 : 255;
      const off = rowStart + 1 + x * 4;
      raw[off] = value;
      raw[off + 1] = value;
      raw[off + 2] = value;
      raw[off + 3] = 255;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace method: none

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The inverse of `qrPng`: reads an 8-bit RGBA, filter-"None" PNG back into raw pixels `decodeQr` can scan. Throws on anything else -- this is a check on `qrPng`'s own output, not a general-purpose PNG reader. */
function readQrPng(buf: Buffer): Pixels {
  if (!buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("invite: blob.png is not a PNG file (bad signature)");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = -1;
  let colorType = -1;
  const idatParts: Buffer[] = [];

  while (offset < buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.toString("ascii", offset + 4, offset + 8);
    const data = buf.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8] ?? -1;
      colorType = data[9] ?? -1;
    } else if (type === "IDAT") {
      idatParts.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    offset += 8 + length + 4; // length + type + data + crc
  }

  if (bitDepth !== 8 || colorType !== 6) {
    throw new Error(
      `invite: blob.png is not the 8-bit RGBA PNG qrPng() writes (bitDepth=${bitDepth}, colorType=${colorType})`,
    );
  }

  const raw = inflateSync(Buffer.concat(idatParts));
  const stride = width * 4;
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    if (filter !== 0) {
      throw new Error(
        `invite: blob.png uses PNG filter type ${filter}, not "None" (0) -- qrPng() never writes that`,
      );
    }
    for (let i = 0; i < stride; i++) data[y * stride + i] = raw[rowStart + 1 + i] ?? 0;
  }
  return { data, width, height };
}

// ---------------------------------------------------------------------------

interface MintedInvitation {
  id: string;
  expiresAt: number;
  blob: string;
  link: string;
}

async function main(): Promise<void> {
  const adminUser = requireEnv("ADMIN_USER");
  const adminPassword = requireEnv("ADMIN_PASSWORD");
  const doorPort = requireEnv("DOOR_PORT");
  const rolesJson = requireEnv("ROLES_JSON");
  const outDir = requireEnv("OUT_DIR");
  const expectedHubPeerId = requireEnv("EXPECTED_HUB_PEER_ID");
  const ttlMs = process.env.TTL_MS;

  const roles: string[] = JSON.parse(rolesJson);
  const body: Record<string, unknown> = { roles };
  if (ttlMs) body.ttlMs = Number(ttlMs);

  const base = `http://127.0.0.1:${doorPort}`;
  const auth = Buffer.from(`${adminUser}:${adminPassword}`).toString("base64");
  console.log(`POST ${base}/hub/api/invitations ${JSON.stringify(body)}`);
  const res = await fetch(`${base}/hub/api/invitations`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Basic ${auth}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`invite: POST /hub/api/invitations -> ${res.status} ${await res.text()}`);
  }
  const minted = (await res.json()) as MintedInvitation;
  console.log(
    `minted invitation ${minted.id} (roles ${JSON.stringify(roles)}, expires ${new Date(minted.expiresAt).toISOString()})`,
  );

  mkdirSync(outDir, { recursive: true });
  const blobPath = `${outDir}/blob.txt`;
  const pngPath = `${outDir}/blob.png`;
  const linkPath = `${outDir}/link.txt`;

  // The primary artifact: the blob alone, no trailing newline, so a byte
  // read of this file is exactly the string a client pastes or scans.
  writeFileSync(blobPath, minted.blob);

  const modules = qrModules(minted.blob);
  writeFileSync(pngPath, qrPng(modules));

  writeFileSync(
    linkPath,
    "# ONE convenience way to use the blob in blob.txt: opening this URL hands the\n" +
      '# blob to whatever page HUB_JOIN_PAGE_URL names (see README.md\'s "Inviting").\n' +
      "# The blob is the credential, not this link -- any application that can read\n" +
      "# blob.txt or scan blob.png can join with it, without ever visiting this URL.\n" +
      `${minted.link}\n`,
  );

  console.log(`wrote ${blobPath}`);
  console.log(`wrote ${pngPath}`);
  console.log(`wrote ${linkPath}`);

  // Step 2: round-trip blob.txt through the repo's own decoder. A blob the
  // widget would reject is the actual failure mode this guards against.
  const blobText = readFileSync(blobPath, "utf8");
  const input = readJoinInputFromText(blobText);
  if (input?.kind !== "blob") {
    throw new Error(
      `invite: CHECK 1 FAILED -- readJoinInputFromText did not return a blob: ${JSON.stringify(input)}`,
    );
  }
  if (input.blob.hubPeerId !== expectedHubPeerId) {
    throw new Error(
      `invite: CHECK 1 FAILED -- decoded hubPeerId "${input.blob.hubPeerId}" does not match the hub's own "${expectedHubPeerId}"`,
    );
  }
  console.log(
    `CHECK 1 PASS: blob.txt round-trips through readJoinInputFromText -- kind "blob", hub ${input.blob.hubPeerId}`,
  );

  // Step 3: decode blob.png with the repo's own decoder and compare against
  // blob.txt byte for byte. A QR nobody can scan back is worse than none.
  const pixels = readQrPng(readFileSync(pngPath));
  const decoded = decodeQr(pixels);
  if (decoded !== minted.blob) {
    throw new Error(
      `invite: CHECK 2 FAILED -- blob.png decoded to ${decoded === null ? "nothing (no QR found)" : "a different string"}\n` +
        `  expected: ${minted.blob}\n  decoded:  ${decoded}`,
    );
  }
  console.log("CHECK 2 PASS: blob.png decodes back to blob.txt's exact contents, byte for byte");
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exitCode = 1;
});
