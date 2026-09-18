/**
 * The images page: a member that serves pictures to the mesh.
 *
 * ISO-FUNCTIONAL with the sandbox's `pages/image-peer/main.ts`, on the
 * extracted libraries. What is gone is `peer-runtime.ts` and the hand-rolled
 * session: `createSession` from `httpeers-member/browser` is both, and the
 * join widget from `@statewalker/httpeers-join` renders `SessionState` and
 * calls the controls.
 *
 * THE GALLERY RENDERS FROM LOCAL BYTES, NOT A FETCH. What this peer serves and
 * what it shows itself are the same catalogue, but the page reads the bytes it
 * already has rather than calling its own mesh endpoint. Going through the
 * edge to display a picture this tab is holding would make the gallery depend
 * on the mesh being up, and a provider that cannot show its own pictures while
 * disconnected looks broken when it is merely offline.
 *
 * THE PICTURES ARE FETCHED, NOT DRAWN. They come from a public image stock on
 * load -- see `../shared/stock.ts`. A peer serving bytes it went and got, to a
 * peer that could have gone and got them itself but asks this one instead, is
 * the claim the mesh makes; a peer serving shapes it drew only proves routing.
 * Drawn pictures remain the FALLBACK, so the page still demonstrates something
 * offline, on a blocked domain, or behind a rate limit.
 *
 * A PICTURE THE PERSON CHOSE IS NOT A SECOND CLASS OF PICTURE. A file from the
 * picker, a photo just taken, and a photograph fetched from the stock all reach
 * `addImage` as `{ info, bytes }` and are served identically -- no other peer
 * can tell which is which, which is the point: a participant is whatever holds
 * the bytes.
 *
 * DISCONNECT STOPS SERVING, AND SAYS SO. `stop()` drops presence and keeps
 * membership, so the advertisement leaves everyone's mesh view within one
 * presence interval and reconnecting needs no new invitation.
 */

import { createMounts } from "@statewalker/httpeers-core";
import { type JoinWidget, mountJoinWidget } from "@statewalker/httpeers-join";
import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createSession } from "@statewalker/httpeers-member/browser";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { createImagesEndpoint, type ImageInfo, imagePath } from "../shared/images.js";
import { fileToImage } from "../shared/local-image.js";
import { EDGE_KEY, meshRules } from "../shared/policy.js";
import { needsPermissiveGater, readRelayAddrs } from "../shared/relay.js";
import { loadStockImages } from "../shared/stock.js";

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`#${id}`);
  if (found == null) throw new Error(`images page: no #${id} in the markup`);
  return found;
};

/** Where the gallery's pictures came from, for the heading. Set once the initial load settles. */
let galleryNote = "loading…";

/** This provider's live catalogue. `createImagesEndpoint` resolves it PER REQUEST, so appending here is immediately servable. */
const images: ImageInfo[] = [];
const files: FilesApi = new MemFilesApi();

let session: PeerSession | undefined;
/** Paste or scan an invitation, see the link, disconnect or leave. Mounted once the session exists. */
let joinWidget: JoinWidget | undefined;

function showError(message: string): void {
  el("error").hidden = false;
  el("error").textContent = message;
}

/**
 * Paint the gallery from the catalogue, reading bytes locally.
 *
 * Object URLs are revoked on every repaint: a page that adds pictures over a
 * long session would otherwise hold every blob it ever rendered.
 */
const objectUrls: string[] = [];
async function renderGallery(): Promise<void> {
  for (const url of objectUrls.splice(0)) URL.revokeObjectURL(url);

  const figures = await Promise.all(
    images.map(async (image) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of files.read(imagePath(image.id))) chunks.push(chunk);
      const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: image.contentType }));
      objectUrls.push(url);

      const figure = document.createElement("figure");
      const img = document.createElement("img");
      img.src = url;
      img.alt = image.title;
      const caption = document.createElement("figcaption");
      caption.textContent = image.title;
      figure.append(img, caption);
      return figure;
    }),
  );

  el("gallery").replaceChildren(...figures);
  el("gallery-source").textContent =
    images.length === 0 ? "(empty — add a picture)" : `(${images.length} local — ${galleryNote})`;
}

/** A drawn picture: the fallback when the stock cannot be reached, so the demo still has something to serve. */
function drawPicture(index: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 320;
  const ctx = canvas.getContext("2d");
  if (ctx == null) throw new Error("images page: no 2d canvas context");
  const hue = (index * 67) % 360;
  ctx.fillStyle = `hsl(${hue} 70% 55%)`;
  ctx.fillRect(0, 0, 320, 320);
  ctx.fillStyle = "rgba(255,255,255,.85)";
  ctx.font = "bold 120px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(index + 1), 160, 160);
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob == null ? reject(new Error("toBlob failed")) : resolve(blob)));
  });
}

/** Put one picture into the library. Safe at any time, joined or not. */
async function addImage(info: ImageInfo, bytes: Uint8Array): Promise<void> {
  await files.write(
    imagePath(info.id),
    (async function* () {
      yield bytes;
    })(),
  );
  // Appended AFTER the bytes are written: the endpoint resolves the catalogue
  // per request, so an entry that appeared first would be listable and 404 on
  // fetch for as long as the write took.
  images.push(info);
}

/** One drawn picture, added. The fallback path, used when the stock is unreachable. */
async function addDrawnPicture(): Promise<ImageInfo> {
  const index = images.length;
  const id = `pic-${index + 1}`;
  const blob = await drawPicture(index);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const info: ImageInfo = {
    id,
    title: `Drawn here (no stock)`,
    contentType: blob.type,
    size: bytes.length,
  };
  await addImage(info, bytes);
  return info;
}

/**
 * The button: one more photograph from the stock, or a drawn one if it cannot
 * be reached.
 *
 * Falling back rather than reporting the failure and stopping keeps the button
 * meaning one thing -- "there is now one more picture to serve" -- whatever the
 * network is doing. The caption says which kind arrived.
 */
async function addPicture(): Promise<void> {
  el("add-status").textContent = "fetching…";
  const [fetched] = await loadStockImages({ count: 1 });

  let info: ImageInfo;
  let note = "";
  if (fetched == null) {
    info = await addDrawnPicture();
    note = ", drawn — the stock did not answer";
  } else {
    info = fetched.info;
    await addImage(info, fetched.bytes);
  }

  el("add-status").textContent = `added ${info.id} (${info.size} bytes${note})`;
  await renderGallery();
}

/**
 * The two file inputs.
 *
 * `accept="image/*"` alone lets a phone offer the camera OR the photo library.
 * The second control adds `capture="environment"`, which goes straight to the
 * rear camera -- and REMOVES the ability to choose an existing picture. Both
 * exist because either one alone is half the feature.
 *
 * Nothing here asks for `getUserMedia`. A file input with `capture` gets the
 * same photograph with no permission prompt to manage, no video element to
 * tear down, and no camera left running when the tab is backgrounded.
 */
function wirePicker(id: string): void {
  const input = el<HTMLInputElement>(id);
  input.addEventListener("change", () => {
    void (async () => {
      const chosen = Array.from(input.files ?? []);
      if (chosen.length === 0) return;

      let added = 0;
      for (const file of chosen) {
        try {
          const { info, bytes } = await fileToImage(file);
          await addImage(info, bytes);
          added += 1;
        } catch (err) {
          // One bad file must not silently swallow the rest of a multi-select.
          el("pick-status").textContent =
            `${file.name}: ${err instanceof Error ? err.message : String(err)}`;
          console.warn("images page: could not add a picture:", err);
        }
      }

      if (added > 0) {
        el("pick-status").textContent = `Added ${added} picture(s). Being served to the mesh now.`;
        await renderGallery();
      }
      // Reset, so choosing the SAME file again fires `change` a second time.
      input.value = "";
    })();
  });
}

/** Everything the page shows about where the session is. */
function render(state: SessionState): void {
  el("state").textContent = state.phase.kind;
  el("peer-id").textContent = state.identity ?? "…";

  const live = state.phase.kind === "live";
  el("serving").textContent = live ? `yes — ${images.length} image(s)` : "no";

  // The join form, the phase and its message, and the session controls.
  joinWidget?.update(state);
}

async function main(): Promise<void> {
  // Pictures up front, so the page has something to serve and to show the
  // moment it loads -- including before it has joined anything. Fetched in
  // PARALLEL by `loadStockImages`, then written here in order, so the gallery
  // is not four sequential round trips.
  const stock = await loadStockImages();
  for (const { info, bytes } of stock) await addImage(info, bytes);
  if (stock.length === 0) {
    // Offline, a blocked domain, a VPN, a rate limit. A provider advertising an
    // image service with an empty catalogue is a worse demonstration than one
    // serving two drawn squares, and the difference is invisible to every other
    // peer in the mesh.
    await addDrawnPicture();
    await addDrawnPicture();
  }
  galleryNote =
    stock.length > 0
      ? `${stock.length} fetched from an image stock on load — reload for a different set`
      : "the image stock could not be reached, so these were drawn here";

  const relayAddrs = await readRelayAddrs();

  const mounts = createMounts();
  mounts.provide("/images", createImagesEndpoint({ files, images }));

  session = createSession({
    key: EDGE_KEY,
    mounts,
    rules: meshRules(),
    // Rides on every heartbeat, so it leaves the mesh view when this peer
    // stops beating -- which is what makes disconnect visible to others.
    advertisements: () => [{ id: "images", kind: "images", title: "Images" }],
    dev: needsPermissiveGater(relayAddrs),
    serviceWorkerUrl: "/sw.js",
    onChange: render,
    // The relay comes from the deployment, not from a build-time constant.
    readDeploymentConfig: async () => null,
  });

  joinWidget = mountJoinWidget(el("mesh-join"), { session, state: session.state() });
  wirePicker("pick-file");
  wirePicker("take-photo");
  el<HTMLButtonElement>("add").addEventListener("click", () => {
    void addPicture().catch((err: unknown) => {
      el("add-status").textContent = `could not add: ${String(err)}`;
    });
  });

  await renderGallery();
  await session.start();
}

main().catch((err: unknown) => {
  el("state").textContent = "error";
  showError(
    `${String(err)}\n\nIf this keeps happening, reset this app from the link below — it clears ` +
      "this browser's copy and starts over.",
  );
});
