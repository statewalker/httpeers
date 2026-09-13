/**
 * Scanning a QR in a page: from the live camera, or from a picture already on
 * the device.
 *
 * WHY THIS EXISTS ALONGSIDE `decodeQr`, AND IS NOT THE SAME THING. `./decode.ts`
 * takes pixels and runs anywhere — a server, a worker, a test. It is the
 * isomorphic half, and it is genuinely useful. What it CANNOT do is point a
 * camera at a code, and that turns out to be the difference between a feature
 * that works and one that does not:
 *
 *   - A still frame gets exactly ONE attempt, and that attempt has to survive
 *     whatever angle, blur, glare and white balance the phone produced. The
 *     first version of this feature was still-photo only and failed on real
 *     photographs — a screenshot decoded, a photo of the same screen did not.
 *   - A live camera gets dozens of attempts a second WHILE THE PERSON WATCHES
 *     THE PREVIEW AND ADJUSTS. That aiming feedback is what makes scanning
 *     reliable, and no file picker can offer it.
 *
 * So `html5-qrcode` here, `jsqr` there. Rung 03 measured them over twelve
 * manufactured degradations of a real join blob — 9/12 against 8/12, differing
 * on heavy blur — which is close enough that the split is about the CAMERA,
 * not about decoder quality. The file path is kept because a code can arrive
 * as a screenshot somebody sent, and because a camera can be refused or
 * absent.
 *
 * FORMAT-AGNOSTIC ON PURPOSE. Nothing here knows what an invitation looks
 * like; the caller passes `accept`, which turns a decoded string into whatever
 * it was looking for, or `null`. `@statewalker/httpeers-member`'s
 * `invitationFromQrText` is that function for join codes, and it lives there
 * because a QR package that knew the join format could not be used for
 * anything else.
 *
 * `html5-qrcode` IS AN OPTIONAL PEER DEPENDENCY. A consumer that only encodes,
 * or only decodes pixels, should not be made to install a camera library; this
 * entry is the only thing that imports it.
 */

import { Html5Qrcode } from "html5-qrcode";

/** The page globals this file names, declared locally rather than by pulling in the DOM lib. */
declare const document: {
  createElement(tag: string): {
    id: string;
    hidden: boolean;
    remove(): void;
  };
  body: { append(node: unknown): void };
};

/**
 * Where the library mounts its work. A real `HTMLElement` satisfies this; the
 * only thing either path actually needs is the `id`, because `html5-qrcode`
 * addresses its host by id rather than by reference.
 */
export interface ScanHost {
  id: string;
}

/** What a scan found, or the reason it found nothing. */
export type QrScan<T> =
  | { ok: true; value: T }
  /** A QR was read, but `accept` did not recognise it — a wifi code, a URL, a poster. */
  | { ok: false; reason: "not-accepted"; text: string }
  /** No QR anywhere in the image: wrong picture, too blurry, too small, glare. */
  | { ok: false; reason: "no-qr" };

export interface ScanFileOptions<T> {
  /** Turns the decoded text into the thing being looked for, or `null`. */
  accept: (text: string) => T | null;
}

/**
 * Find a code in an image file. NEVER THROWS: every failure comes back as a
 * reason the caller can render, because "no QR in this photo" is an ordinary
 * outcome and not an error.
 */
export async function scanFile<T>(file: Blob, options: ScanFileOptions<T>): Promise<QrScan<T>> {
  const host = scratchHost();
  const reader = new Html5Qrcode(host.id, { verbose: false });
  try {
    // `showImage: false` — the library would otherwise paint the picture into
    // our hidden host, which costs a full-size decode of a phone photo for
    // something nobody sees.
    const result = await reader.scanFileV2(file as File, false);
    const text = result.decodedText;
    const value = options.accept(text);
    return value != null ? { ok: true, value } : { ok: false, reason: "not-accepted", text };
  } catch {
    // The library rejects when it finds nothing; it does not distinguish "no
    // code" from "unreadable", and neither can the person holding the phone —
    // both mean try again with a better view.
    return { ok: false, reason: "no-qr" };
  } finally {
    try {
      reader.clear();
    } catch {
      /* nothing rendered, nothing to clear */
    }
    host.remove();
  }
}

export interface CameraScan {
  /** Stop the camera and release the track. Safe to call twice. */
  stop(): Promise<void>;
}

export interface ScanFromCameraOptions<T> {
  accept: (text: string) => T | null;
  /** Called once, with the first accepted code. The camera is stopped before this runs. */
  onCode: (value: T) => void;
  /** Frames per second to attempt. 10 is the incumbent's measured setting. */
  fps?: number;
}

/**
 * Scan continuously from the rear camera into `host`, stopping itself on the
 * first accepted code.
 *
 * REJECTS if the camera cannot be started at all — refused permission, no
 * camera, or an insecure origin. That rejection is the caller's cue to offer
 * the file picker, which is the way through in exactly those cases, so it is
 * deliberately NOT swallowed the way a per-frame miss is.
 */
export async function scanFromCamera<T>(
  host: ScanHost,
  options: ScanFromCameraOptions<T>,
): Promise<CameraScan> {
  const reader = new Html5Qrcode(host.id, { verbose: false });
  let stopped = false;

  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      if (reader.isScanning) await reader.stop();
      reader.clear();
    } catch {
      /* already torn down */
    }
  };

  await reader.start(
    // `facingMode: environment` asks for the rear camera by CONSTRAINT rather
    // than by device id, so it works without first enumerating devices —
    // which on some browsers needs a permission of its own.
    { facingMode: "environment" },
    {
      fps: options.fps ?? 10,
      // NO `qrbox`. It is a CROP, not a decoration: html5-qrcode decodes only
      // what falls inside it, and it is measured against the RENDERED
      // viewfinder rather than the camera's own resolution. Both a fixed
      // 260x260 box and a box computed from a 320px preview cut a QR that
      // fills the frame — which is exactly what a person does when told to
      // point the camera at a code. Measured: a 1280x720 frame whose QR the
      // file path decoded scanned as nothing in the live path until this was
      // removed. Scanning the whole frame costs a little more per frame, on a
      // task that runs for a few seconds once.
      aspectRatio: undefined,
    },
    (text) => {
      const value = options.accept(text);
      // A QR THAT IS NOT ACCEPTED MUST NOT STOP THE SCAN: the camera is very
      // likely still pointed at a poster or a wifi sticker, and giving up on
      // the first wrong code would be worse than carrying on looking.
      if (value == null) return;
      void stop().then(() => options.onCode(value));
    },
    // Per-frame misses are the normal state of a live scanner, not errors.
    () => {},
  );

  return { stop };
}

/** A detached element for the library to work in while scanning a file — it renders nothing anyone sees. */
function scratchHost(): { id: string; remove(): void } {
  const host = document.createElement("div");
  // `crypto.randomUUID` rather than `Math.random`: two scans running at once
  // must not share a host id, and this costs nothing.
  host.id = `qr-scan-${crypto.randomUUID()}`;
  host.hidden = true;
  document.body.append(host);
  return host;
}
