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
import { buttonClass, inputClass, Modal, primaryButtonClass } from "../ui/Modal.js";
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

  const opener = (
    <button
      type="button"
      className="text-xs text-blue-700 underline"
      onClick={() => setStep({ kind: "form", failure: null, busy: false })}
    >
      Key for a member
    </button>
  );
  if (step.kind === "closed") return opener;

  if (step.kind === "form") {
    return (
      <>
        {opener}
        <Modal title="Key for a member">
          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <p className="text-sm text-gray-700">
              Creates a LiteLLM key that expires in 30 days, for you to send to a member. The name
              goes into the key's alias, so you can find and delete it in the dashboard.
            </p>
            <label className="flex flex-col gap-1 text-sm">
              Who is it for
              <input
                className={inputClass}
                autoComplete="off"
                placeholder="e.g. alice"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {step.failure != null && (
              <p role="alert" className="text-sm text-red-700">
                {step.failure}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonClass} onClick={close}>
                Cancel
              </button>
              <button type="submit" className={primaryButtonClass} disabled={step.busy}>
                Create key
              </button>
            </div>
          </form>
        </Modal>
      </>
    );
  }

  const text = keyShareText(step.key, pageUrl);
  const canShare = typeof navigator.share === "function";
  const setNote = (note: string) => setStep({ ...step, note });
  return (
    <>
      {opener}
      <Modal title="Key for a member">
        <div className="flex flex-col gap-3">
          <p className="text-sm text-gray-700">
            {step.name === "" ? "A new key" : `A key for ${step.name}`}. It is shown only now: copy
            or share it before closing.
          </p>
          <input
            className={`${inputClass} font-mono`}
            readOnly
            aria-label="The new key"
            value={step.key}
            onFocus={(event) => event.target.select()}
          />
          {step.note != null && (
            <p role="status" className="text-sm text-gray-700">
              {step.note}
            </p>
          )}
          <div className="flex justify-end gap-2">
            {canShare && (
              <button
                type="button"
                className={buttonClass}
                onClick={() =>
                  void navigator.share({ title: "LLM chat key", text }).catch(() => undefined)
                }
              >
                Share
              </button>
            )}
            <button
              type="button"
              className={buttonClass}
              onClick={() =>
                void navigator.clipboard.writeText(text).then(
                  () => setNote("Copied: the key and the page to paste it into."),
                  () => setNote("Copying failed; select the key above and copy it by hand."),
                )
              }
            >
              Copy
            </button>
            <button type="button" className={primaryButtonClass} onClick={close}>
              Done
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
}
