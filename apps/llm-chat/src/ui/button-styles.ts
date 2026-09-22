/**
 * Plain Tailwind class strings for the few spots that still render a bare `<button>`/`<input>`
 * rather than a shadcn primitive: `pages/mesh.tsx`'s pre-chat forms (the join/finding/key screens
 * shown before `ChatApp` mounts, which have no settings dialog or shadcn primitives available to
 * them yet). Split out of the old `Modal.tsx` when it and `ModelDialog.tsx` were deleted (Task 5)
 * so those call sites kept compiling without pulling in the dialog rewrite. `Thread.tsx`'s composer
 * moved onto shadcn primitives since and no longer imports this file -- `pages/mesh.tsx` is now the
 * only consumer.
 */

export const buttonClass =
  "rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-100 disabled:opacity-50";
export const primaryButtonClass =
  "rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50";
export const inputClass = "w-full rounded border border-gray-300 px-2 py-1.5 text-sm";
