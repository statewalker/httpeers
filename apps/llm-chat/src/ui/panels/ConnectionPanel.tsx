/**
 * The base-URL/key form and the Test button, out of the old `SettingsDialog`. Registered into
 * `settingsPanelsSlot` by whoever owns the config (`ChatApp`, for now) — this component itself
 * knows nothing about slots, tabs, or dialogs.
 */

import { useState } from "react";
import { normalizeBaseUrl } from "../../core/config.js";
import { describeError, listModels } from "../../core/openai-client.js";
import { Button } from "../primitives/button.js";
import { Input } from "../primitives/input.js";
import { Label } from "../primitives/label.js";

export interface ConnectionPanelProps {
  /** `apiKeyHeader` is not edited here, only used by Test: it is kept by `applyEndpoint` on save. */
  initial: { baseUrl: string; apiKey?: string; apiKeyHeader?: string } | null;
  onSave(endpoint: { baseUrl: string; apiKey: string }): void;
  /** Injected by tests; defaults to `window.fetch`, same seam as `ChatApp`'s `fetchImpl`. */
  fetchImpl?: typeof fetch;
}

export function ConnectionPanel({ initial, onSave, fetchImpl }: ConnectionPanelProps) {
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? "");
  const [status, setStatus] = useState("");

  const test = async (): Promise<void> => {
    setStatus("Testing…");
    try {
      const models = await listModels(
        {
          baseUrl: normalizeBaseUrl(baseUrl),
          apiKey,
          apiKeyHeader: initial?.apiKeyHeader,
        },
        { fetchImpl },
      );
      setStatus(`Connected: ${models.length} model(s) available.`);
    } catch (error) {
      const { message, hint } = describeError(error);
      setStatus(`Failed: ${message}${hint == null ? "" : ` ${hint}`}`);
    }
  };

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ baseUrl, apiKey });
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor="connection-base-url">Base URL</Label>
        <Input
          id="connection-base-url"
          type="url"
          required
          placeholder="https://api.openai.com/v1"
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="connection-api-key">API key</Label>
        <Input
          id="connection-api-key"
          type="password"
          autoComplete="off"
          placeholder="optional"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
        />
      </div>
      <p role="status" className="min-h-5 text-sm text-muted-foreground">
        {status}
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={baseUrl === ""}
          onClick={() => void test()}
        >
          Test
        </Button>
        <Button type="submit">Save</Button>
      </div>
    </form>
  );
}
