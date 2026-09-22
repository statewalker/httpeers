/**
 * "Key for a member": an admin mints a LiteLLM key for someone else and hands it over.
 *
 * Only an admin may mint keys (the hub's rules, spec §5.3), and a member's own "Request a key" is
 * refused with a 403. The admin's key step is gone once the admin has a key of their own, so this
 * is the page's way for an admin to give a member one: name the member, create the key, then Copy
 * or Share a message carrying it and the mesh page to paste it into (`keyShareText`).
 *
 * SHOWN ONCE. The key lives in this dialog's state only: closing it drops the key, and nothing
 * stores it. A lost key is deleted in the dashboard by its alias and a new one minted.
 */

import { useState } from "react";
import { Button } from "../ui/primitives/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/primitives/dialog.js";
import { Input } from "../ui/primitives/input.js";
import { Label } from "../ui/primitives/label.js";
import { keyShareText, mintKey } from "./discover.js";

type Step =
  | { kind: "closed" }
  | { kind: "form"; failure: string | null; busy: boolean }
  | { kind: "minted"; name: string; key: string; note: string | null };

export function MemberKeyButton({
  fetchImpl,
  serviceBase,
  pageUrl,
}: {
  fetchImpl: typeof fetch;
  serviceBase: string;
  /** The mesh page members paste the key into; its query and hash are dropped. */
  pageUrl: string;
}) {
  const [step, setStep] = useState<Step>({ kind: "closed" });
  const [name, setName] = useState("");

  const create = async () => {
    setStep({ kind: "form", failure: null, busy: true });
    try {
      const key = await mintKey(fetchImpl, serviceBase, new Date(), name.trim());
      setStep({ kind: "minted", name: name.trim(), key, note: null });
    } catch (error) {
      setStep({
        kind: "form",
        failure: error instanceof Error ? error.message : String(error),
        busy: false,
      });
    }
  };

  const close = () => {
    setStep({ kind: "closed" });
    setName("");
  };

  return (
    <>
      <button
        type="button"
        className="text-xs text-blue-700 underline"
        onClick={() => setStep({ kind: "form", failure: null, busy: false })}
      >
        Key for a member
      </button>
      <Dialog open={step.kind !== "closed"} onOpenChange={(open) => !open && close()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Key for a member</DialogTitle>
          </DialogHeader>
          {step.kind === "form" && (
            <form
              className="flex flex-col gap-3"
              onSubmit={(event) => {
                event.preventDefault();
                void create();
              }}
            >
              <p className="text-sm text-muted-foreground">
                Creates a LiteLLM key that expires in 30 days, for you to send to a member. The name
                goes into the key's alias, so you can find and delete it in the dashboard.
              </p>
              <div className="flex flex-col gap-1">
                <Label htmlFor="member-key-name">Who is it for</Label>
                <Input
                  id="member-key-name"
                  autoComplete="off"
                  placeholder="e.g. alice"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </div>
              {step.failure != null && (
                <p role="alert" className="text-sm text-destructive">
                  {step.failure}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="submit" disabled={step.busy}>
                  Create key
                </Button>
              </div>
            </form>
          )}
          {step.kind === "minted" && (
            <MintedKey
              step={step}
              text={keyShareText(step.key, pageUrl)}
              onNote={(note) => setStep({ ...step, note })}
              onDone={close}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function MintedKey({
  step,
  text,
  onNote,
  onDone,
}: {
  step: Extract<Step, { kind: "minted" }>;
  text: string;
  onNote(note: string): void;
  onDone(): void;
}) {
  const canShare = typeof navigator.share === "function";
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {step.name === "" ? "A new key" : `A key for ${step.name}`}. It is shown only now: copy or
        share it before closing.
      </p>
      <Input
        className="font-mono"
        readOnly
        aria-label="The new key"
        value={step.key}
        onFocus={(event) => event.target.select()}
      />
      {step.note != null && (
        <p role="status" className="text-sm text-muted-foreground">
          {step.note}
        </p>
      )}
      <div className="flex justify-end gap-2">
        {canShare && (
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              void navigator.share({ title: "LLM chat key", text }).catch(() => undefined)
            }
          >
            Share
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => onNote("Copied: the key and the page to paste it into."),
              () => onNote("Copying failed; select the key above and copy it by hand."),
            )
          }
        >
          Copy
        </Button>
        <Button type="button" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
