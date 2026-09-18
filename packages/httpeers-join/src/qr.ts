/**
 * How the widget reads a QR code: a seam, with html5-qrcode behind it.
 *
 * A SEAM BECAUSE A TEST HAS NO CAMERA. The widget's own behaviour -- which
 * button shows, what a scanned code does, what a picture with no code says --
 * is tested through a fake `QrScanner`; the real one is two calls into
 * `@statewalker/httpeers-qr/browser`, which has its own tests.
 *
 * THE CAMERA LIBRARY IS LOADED ON THE FIRST SCAN, NOT AT IMPORT. `html5-qrcode`
 * is the largest thing in this package's closure by far, and most visits to a
 * join page never scan anything: they resume, or arrive with `?join=`. A
 * dynamic `import()` gives a bundler its own chunk to fetch only when someone
 * presses a scan button, and keeps importing this module free of anything
 * that needs a browser.
 *
 * WHAT COUNTS AS AN INVITATION is `invitationFromQrText` from
 * `@statewalker/httpeers-member`: a join link (`?join=` or `?invite=`) or a
 * join blob. A bare invitation id does NOT count from a QR -- nothing tells it
 * apart from any other short string -- which is why a live scan carries on
 * past a wifi sticker instead of trying to join with it.
 */

import { invitationFromQrText } from "@statewalker/httpeers-member";

/** A running camera scan. */
export interface QrCameraScan {
  stop(): Promise<void>;
}

/** What a picture held. */
export type QrFileScan =
  | { ok: true; invitation: string }
  /** `no-qr`: nothing readable in it. `not-accepted`: a QR, but not an invitation. */
  | { ok: false; reason: "no-qr" | "not-accepted" };

export interface QrScanner {
  /** Whether a camera can even be asked for. `false` hides the camera button; the picture stays. */
  cameraAvailable(): boolean;
  /**
   * Scan from the camera into `host` (which has an `id`, and is visible) and
   * call `onInvitation` once with the first invitation seen, the camera
   * already stopped. REJECTS when the camera cannot start -- refused, absent,
   * or an insecure origin -- which the widget turns into "choose a picture".
   */
  scanCamera(host: HTMLElement, onInvitation: (invitation: string) => void): Promise<QrCameraScan>;
  /** Find an invitation in a picture. Never rejects for an ordinary miss; that is `ok: false`. */
  scanFile(file: Blob): Promise<QrFileScan>;
}

/**
 * The real scanner: the rear camera or a picture, through
 * `@statewalker/httpeers-qr/browser`.
 *
 * `cameraAvailable` asks only whether `getUserMedia` exists. That is `false`
 * on an insecure origin (browsers remove `mediaDevices` there) and in a
 * browser with no camera API, which are the two cases where a button would be
 * a promise the page cannot keep. A camera that exists but is refused is
 * found out by pressing the button, and said then.
 */
export function defaultQrScanner(): QrScanner {
  return {
    cameraAvailable: () =>
      typeof navigator !== "undefined" &&
      typeof navigator.mediaDevices?.getUserMedia === "function",
    async scanCamera(host, onInvitation) {
      const { scanFromCamera } = await import("@statewalker/httpeers-qr/browser");
      return scanFromCamera(host, { accept: invitationFromQrText, onCode: onInvitation });
    },
    async scanFile(file) {
      const { scanFile } = await import("@statewalker/httpeers-qr/browser");
      const found = await scanFile(file, { accept: invitationFromQrText });
      if (found.ok) return { ok: true, invitation: found.value };
      // A QR was read and it was not an invitation: a second decoder would
      // only read the same wrong code.
      if (found.reason === "not-accepted") return { ok: false, reason: "not-accepted" };
      const text = await decodePicture(file);
      if (text == null) return { ok: false, reason: "no-qr" };
      const invitation = invitationFromQrText(text);
      return invitation != null ? { ok: true, invitation } : { ok: false, reason: "not-accepted" };
    },
  };
}

/**
 * The longest sides a picture is decoded at, largest first, when
 * html5-qrcode found nothing.
 */
const FALLBACK_SIDES = [1600, 800, 400];

/**
 * A second decoder for a picture: `decodeQr` (jsQR) from
 * `@statewalker/httpeers-qr`, over the picture drawn at a few sizes.
 *
 * WHY THIS EXISTS. Measured on the demos hub page's own invitation QR (a
 * 310-character join blob), html5-qrcode's `scanFile` found nothing in a
 * clean 684x684 screenshot, nor at 600 or 480 pixels, and read it at 400
 * and 300. A phone screenshot or photo is far larger than that. jsQR read the
 * same 684-pixel picture at once. The two decoders fail on different
 * pictures (the package's rung 03 measured 9/12 and 8/12 over twelve
 * degradations, differing on heavy blur), so trying both costs a second only
 * when the first has already failed.
 *
 * The sizes go DOWN from the picture's own size, capped at 1600: jsQR is
 * slow on a 12-megapixel photo, and a code that fills a phone photo is still
 * many pixels per module at 1600.
 */
async function decodePicture(file: Blob): Promise<string | null> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null; // not a picture the browser can open
  }
  try {
    const { decodeQr } = await import("@statewalker/httpeers-qr");
    const longest = Math.max(bitmap.width, bitmap.height);
    const sides = [Math.min(longest, FALLBACK_SIDES[0] as number)];
    for (const side of FALLBACK_SIDES) if (side < (sides[0] as number)) sides.push(side);
    for (const side of sides) {
      const scale = side / longest;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context == null) return null;
      context.drawImage(bitmap, 0, 0, width, height);
      const text = decodeQr(context.getImageData(0, 0, width, height));
      if (text != null) return text;
    }
    return null;
  } finally {
    bitmap.close();
  }
}
