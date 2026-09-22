/**
 * `ModelDialog.tsx`'s content, as a settings-dialog panel: lists the models the endpoint serves
 * and lets the user pick or type one. Registered into `settingsPanelsSlot` by whoever owns the
 * config (`ChatApp`, for now) — this component itself knows nothing about slots, tabs, or dialogs.
 */

import { useEffect, useState } from "react";
import {
  describeError,
  type EndpointConfig,
  isAbort,
  listModels,
} from "../../core/openai-client.js";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";

export interface ModelsPanelProps {
  endpoint: EndpointConfig;
  current?: string;
  onPick(models: string[], model: string): void;
  /** Injected by tests; defaults to `window.fetch`, same seam as `ChatApp`'s `fetchImpl`. */
  fetchImpl?: typeof fetch;
}

export function ModelsPanel({ endpoint, current, onPick, fetchImpl }: ModelsPanelProps) {
  const { baseUrl, apiKey, apiKeyHeader } = endpoint;
  const [models, setModels] = useState<string[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [choice, setChoice] = useState(current ?? "");

  useEffect(() => {
    const controller = new AbortController();
    listModels({ baseUrl, apiKey, apiKeyHeader }, { signal: controller.signal, fetchImpl }).then(
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
  }, [baseUrl, apiKey, apiKeyHeader, fetchImpl]);

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (choice.trim() !== "") onPick(models ?? [], choice.trim());
      }}
    >
      {models == null && <p className="text-sm text-muted-foreground">Loading models…</p>}
      {failure != null && (
        <p role="alert" className="text-sm text-destructive">
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
        <div className="flex flex-col gap-1">
          <label className="text-sm" htmlFor="models-panel-manual-id">
            Model id
          </label>
          <Input
            id="models-panel-manual-id"
            value={choice}
            onChange={(event) => setChoice(event.target.value)}
          />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={choice.trim() === ""}>
          Use model
        </Button>
      </div>
    </form>
  );
}
