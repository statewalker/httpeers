import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Combines class names and resolves conflicting Tailwind utility classes, keeping the last one. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
