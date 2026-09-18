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
      return found.ok ? { ok: true, invitation: found.value } : { ok: false, reason: found.reason };
    },
  };
}
