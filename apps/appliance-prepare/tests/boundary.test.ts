import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), "../src");

async function closureFrom(entry: string): Promise<Set<string>> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(file, "utf8");
    for (const match of text.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)) {
      const spec = match[1];
      if (spec.startsWith(".")) queue.push(resolve(dirname(file), spec.replace(/\.js$/, ".ts")));
    }
  }
  return seen;
}

function specifiersOf(text: string): string[] {
  return [...text.matchAll(/(?:^|\n)\s*(?:import|export)[^;]*?from\s+"([^"]+)"/g)].map((m) => m[1]);
}

describe("the prepare tool's dependency closure", () => {
  // Two entry points run in the same stock node:22-alpine with no `npm
  // install`: `main.ts` (bin/prepare.sh) and `verify-backend-cli.ts`
  // (scripts/verify-backend.sh, Task 10). Measuring only main.ts's closure
  // would let a dependency slip in through the second entry point unnoticed
  // -- so both are walked here, not exempted by filename.
  it.each(["main.ts", "verify-backend-cli.ts"])(
    "imports nothing but node: builtins and its own files, from %s",
    async (entry) => {
      const files = await closureFrom(resolve(SRC, entry));
      const offenders: string[] = [];
      for (const file of files) {
        for (const spec of specifiersOf(await readFile(file, "utf8"))) {
          if (!spec.startsWith(".") && !spec.startsWith("node:"))
            offenders.push(`${file}: ${spec}`);
        }
      }
      expect(offenders).toEqual([]);
    },
  );
});
