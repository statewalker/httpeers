import { useState } from "react";

export interface ModelPickerProps {
  models: string[];
  value: string | undefined;
  disabled: boolean;
  onChange(model: string): void;
  onRefresh(): Promise<void>;
}

export function ModelPicker({ models, value, disabled, onChange, onRefresh }: ModelPickerProps) {
  const [refreshing, setRefreshing] = useState(false);
  return (
    <div className="flex items-center gap-1">
      <label className="sr-only" htmlFor="model-picker">
        Model
      </label>
      <select
        id="model-picker"
        className="rounded border border-gray-300 px-2 py-1 text-sm"
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {models.map((model) => (
          <option key={model} value={model}>
            {model}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label="Refresh models"
        title="Refresh models"
        className="rounded px-2 py-1 text-sm hover:bg-gray-100 disabled:opacity-50"
        disabled={disabled || refreshing}
        onClick={async () => {
          setRefreshing(true);
          try {
            await onRefresh();
          } finally {
            setRefreshing(false);
          }
        }}
      >
        ↻
      </button>
    </div>
  );
}
