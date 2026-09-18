import type { ReactNode } from "react";

/** A centred dialog over a dimmed page. Closing is the caller's decision. */
export function Modal({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="fixed inset-0 z-10 flex items-center justify-center bg-black/40 p-4">
      <dialog
        open
        aria-label={title}
        className="static m-0 w-full max-w-md rounded-lg bg-white p-5 text-gray-900 shadow-xl"
      >
        <h2 className="mb-4 text-lg font-semibold">{title}</h2>
        {children}
      </dialog>
    </div>
  );
}

export const buttonClass =
  "rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50";
export const primaryButtonClass =
  "rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50";
export const inputClass = "w-full rounded border border-gray-300 px-2 py-1.5 text-sm";
