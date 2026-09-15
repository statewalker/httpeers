import { useState } from "react";
import { normalizeBaseUrl } from "../core/config.js";
import { describeError, listModels } from "../core/openai-client.js";
import { buttonClass, inputClass, Modal, primaryButtonClass } from "./Modal.js";

export interface SettingsDialogProps {
  /** `apiKeyHeader` is not edited here, only used by Test: it is kept by `applyEndpoint` on save. */
  initial: { baseUrl: string; apiKey?: string; apiKeyHeader?: string } | null;
  /** False on first run: there is nothing to go back to. */
  dismissible: boolean;
  onSave(endpoint: { baseUrl: string; apiKey: string }): void;
  onClose(): void;
}

export function SettingsDialog({ initial, dismissible, onSave, onClose }: SettingsDialogProps) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [status, setStatus] = useState("");

  const test = async (): Promise<void> => {
    setStatus("Testing…");
    try {
      const models = await listModels({
        baseUrl: normalizeBaseUrl(baseUrl),
        apiKey,
        apiKeyHeader: initial?.apiKeyHeader,
      });
      setStatus(`Connected: ${models.length} model(s) available.`);
    } catch (error) {
      const { message, hint } = describeError(error);
      setStatus(`Failed: ${message}${hint == null ? "" : ` ${hint}`}`);
    }
  };

  return (
    <Modal title="Connection settings">
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          onSave({ baseUrl, apiKey });
        }}
      >
        <label className="flex flex-col gap-1 text-sm">
          Base URL
          <input
            className={inputClass}
            type="url"
            required
            placeholder="https://api.openai.com/v1"
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          API key
          <input
            className={inputClass}
            type="password"
            autoComplete="off"
            placeholder="optional"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
          />
        </label>
        <p role="status" className="min-h-5 text-sm text-gray-600">
          {status}
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            className={buttonClass}
            disabled={baseUrl === ""}
            onClick={() => void test()}
          >
            Test
          </button>
          {dismissible && (
            <button type="button" className={buttonClass} onClick={onClose}>
              Cancel
            </button>
          )}
          <button type="submit" className={primaryButtonClass}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}
