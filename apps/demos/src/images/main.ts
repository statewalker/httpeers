/**
 * The images page: a member that serves pictures to the mesh.
 *
 * ISO-FUNCTIONAL with the sandbox's `pages/image-peer/main.ts`, on the
 * extracted libraries. What is gone is `peer-runtime.ts` and the hand-rolled
 * session: `createSession` from `httpeers-member/browser` is both, and this
 * file renders `SessionState` and calls the four controls.
 *
 * THE GALLERY RENDERS FROM LOCAL BYTES, NOT A FETCH. What this peer serves and
 * what it shows itself are the same catalogue, but the page reads the bytes it
 * already has rather than calling its own mesh endpoint. Going through the
 * edge to display a picture this tab is holding would make the gallery depend
 * on the mesh being up, and a provider that cannot show its own pictures while
 * disconnected looks broken when it is merely offline.
 *
 * DISCONNECT STOPS SERVING, AND SAYS SO. `stop()` drops presence and keeps
 * membership, so the advertisement leaves everyone's mesh view within one
 * presence interval and reconnecting needs no new invitation.
 */

import { MemFilesApi } from "@statewalker/webrun-files-mem";
import type { FilesApi } from "@statewalker/webrun-files";
import { createMounts } from "@statewalker/httpeers-core";
import type { PeerSession, SessionState } from "@statewalker/httpeers-member";
import { createSession } from "@statewalker/httpeers-member/browser";
import { ensureBiscuit } from "../shared/biscuit.js";
import { createImagesEndpoint, type ImageInfo, imagePath } from "../shared/images.js";
import { EDGE_KEY, meshRules } from "../shared/policy.js";
import { needsPermissiveGater, readRelayAddrs } from "../shared/relay.js";

const el = <T extends HTMLElement>(id: string): T => {
  const found = document.querySelector<T>(`#${id}`);
  if (found == null) throw new Error(`images page: no #${id} in the markup`);
  return found;
};

/** This provider's live catalogue. `createImagesEndpoint` resolves it PER REQUEST, so appending here is immediately servable. */
const images: ImageInfo[] = [];
const files: FilesApi = new MemFilesApi();

let session: PeerSession | undefined;

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
    images.length === 0 ? "(empty — add a picture)" : `(${images.length} local)`;
}

/** A generated picture, so the demo has something to serve with no upload and no network. */
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

async function addPicture(): Promise<void> {
  const index = images.length;
  const id = `pic-${index + 1}`;
  const blob = await drawPicture(index);
  const bytes = new Uint8Array(await blob.arrayBuffer());

  await files.write(
    imagePath(id),
    (async function* () {
      yield bytes;
    })(),
  );
  // Appended AFTER the bytes are written: the endpoint resolves the catalogue
  // per request, so an entry that appeared first would be listable and 404 on
  // fetch for as long as the write took.
  images.push({ id, title: `Picture ${index + 1}`, contentType: blob.type, size: bytes.length });

  el("add-status").textContent = `added ${id} (${bytes.length} bytes)`;
  await renderGallery();
}

/** Everything the page shows about where the session is. */
function render(state: SessionState): void {
  el("state").textContent = state.phase.kind;
  el("peer-id").textContent = state.identity ?? "…";

  const live = state.phase.kind === "live";
  el("serving").textContent = live ? `yes — ${images.length} image(s)` : "no";

  el("join-form").hidden = !state.controls.join;
  el("session-controls").hidden = !(state.controls.disconnect || state.controls.reconnect);
  el<HTMLButtonElement>("reconnect").hidden = !state.controls.reconnect;
  el<HTMLButtonElement>("disconnect").hidden = !state.controls.disconnect;

  const phase = state.phase;
  if (phase.kind === "needs-invitation") {
    el("session-status").textContent = phase.message;
  } else if (phase.kind === "disconnected" || phase.kind === "blocked" || phase.kind === "failed") {
    el("live-status").textContent = phase.message;
  } else if (phase.kind === "live") {
    el("live-status").textContent =
      phase.note ?? `Joined by ${phase.joinedBy}. Serving images to the mesh.`;
  }
}

async function main(): Promise<void> {
  // Before anything touches a token, and before `meshRules()` parses anything.
  await ensureBiscuit();

  // Two pictures up front, so the page has something to serve and to show the
  // moment it loads -- including before it has joined anything.
  await addPicture();
  await addPicture();

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

  el<HTMLButtonElement>("join").addEventListener("click", () => {
    const text = el<HTMLInputElement>("invite").value.trim();
    if (text === "") return;
    void session?.join(text);
  });
  el<HTMLButtonElement>("disconnect").addEventListener("click", () => void session?.disconnect());
  el<HTMLButtonElement>("reconnect").addEventListener("click", () => void session?.reconnect());
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
