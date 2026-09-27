/**
 * The gate an untrusted `?config=` URL must pass before it is obeyed (`judgeConfigUrl`, Task 9;
 * wired in by Task 10). Its job is to stop something, not to be dismissed out of the way: Cancel
 * is the default focused action, and every way out that ISN'T the explicit "Use this" button --
 * Escape, the overlay, Cancel itself -- rejects.
 *
 * `origin` and `baseUrl` are plain strings, not derived here: the caller is the one holding the
 * `ConfigUrlVerdict` and the parsed `ExternalConfig`, and is responsible for substituting
 * something readable (the raw URL, say) when `judgeConfigUrl` reports the WHATWG opaque origin
 * `"null"` -- a dialog that names the danger as literally "null" tells the user nothing.
 */

import { Button } from "./primitives/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./primitives/dialog.js";

export interface ConfirmConfigDialogProps {
  /** The config URL's origin (or a caller-supplied fallback, when the origin is opaque). */
  origin: string;
  /** The endpoint the document wants this chat to use. */
  baseUrl: string;
  onAccept(): void;
  onReject(): void;
}

export function ConfirmConfigDialog({
  origin,
  baseUrl,
  onAccept,
  onReject,
}: ConfirmConfigDialogProps) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Every non-accept way out of a controlled Dialog that never actually changes `open`
        // (Escape, an overlay click) surfaces here as `open === false` -- reject, same as Cancel.
        if (!open) onReject();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Use configuration from an unfamiliar origin?</DialogTitle>
          <DialogDescription>
            <strong>{origin}</strong> wants this chat to send messages, and any key it configures,
            to <strong>{baseUrl}</strong>. Only accept this if you recognize and trust that origin.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button type="button" variant="outline" autoFocus onClick={onReject}>
            Cancel
          </Button>
          <Button type="button" onClick={onAccept}>
            Use this configuration
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
