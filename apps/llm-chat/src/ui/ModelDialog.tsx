import { useEffect, useState } from "react";
import { describeError, type EndpointConfig, isAbort, listModels } from "../core/openai-client.js";
import { buttonClass, inputClass, Modal, primaryButtonClass } from "./Modal.js";

export interface ModelDialogProps {
  endpoint: EndpointConfig;
  current?: string;
  /** False when no model is saved yet: the chat cannot start without one. */
  dismissible: boolean;
  onPick(models: string[], model: string): void;
  onClose(): void;
}

export function ModelDialog({ endpoint, current, dismissible, onPick, onClose }: ModelDialogProps) {
  const { baseUrl, apiKey } = endpoint;
  const [models, setModels] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [choice, setChoice] = useState(current ?? "");

  useEffect(() => {
    const controller = new AbortController();
    listModels({ baseUrl, apiKey }, { signal: controller.signal }).then(
      (list) => {
        setModels(list);
        setChoice((previous) => (list.includes(previous) ? previous : (list[0] ?? "")));
      },
      (error: unknown) => {
        if (isAbort(error)) return;
        const { message, hint } = describeError(error);
        setFailure(`Could not list models: ${message}${hint == null ? "" : ` ${hint}`}`);
        setModels([]);
      },
    );
    return () => controller.abort();
  }, [baseUrl, apiKey]);

  return (
    <Modal title="Choose a model">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (choice.trim() !== "") onPick(models ?? [], choice.trim());
        }}
      >
        {models == null && <p className="text-sm text-gray-600">Loading models…</p>}
        {failure != null && (
          <p role="alert" className="text-sm text-red-700">
            {failure}
          </p>
        )}
        {models != null && models.length > 0 && (
          <fieldset className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            <legend className="sr-only">Models</legend>
            {models.map((model) => (
              <label key={model} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="model"
                  value={model}
                  checked={choice === model}
                  onChange={() => setChoice(model)}
                />
                {model}
              </label>
            ))}
          </fieldset>
        )}
        {models != null && models.length === 0 && (
          <label className="flex flex-col gap-1 text-sm">
            Model id
            <input
              className={inputClass}
              value={choice}
              onChange={(event) => setChoice(event.target.value)}
            />
          </label>
        )}
        <div className="flex justify-end gap-2">
          {dismissible && (
            <button type="button" className={buttonClass} onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className={primaryButtonClass} disabled={choice.trim() === ""}>
            Use model
          </button>
        </div>
      </form>
    </Modal>
  );
}
