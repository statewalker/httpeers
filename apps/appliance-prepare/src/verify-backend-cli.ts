/**
 * `scripts/verify-backend.sh`'s worker: reads one llama-server container's
 * log from stdin, checks it against the backend named on the command line
 * with `backendRan` (see `logcheck.ts`), prints the reason, and exits 0/1.
 *
 * A second entry point, alongside `main.ts` -- both run in the same stock
 * `node:22-alpine` container with no `npm install` (see `bin/prepare.sh` and
 * `scripts/verify-backend.sh`), so both must stay inside the stdlib-only
 * closure `tests/boundary.test.ts` measures. It takes no `Io` injection: the
 * only side effects here are reading stdin and writing stdout/exit code, and
 * the tested logic all lives in `backendRan`.
 */

import type { Backend } from "./backend.ts";
import { backendRan } from "./logcheck.ts";

function isBackend(value: string): value is Backend {
  return (["cpu", "cuda", "vulkan", "intel", "musa"] as string[]).includes(value);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function main(): Promise<void> {
  const [backendArg, service] = process.argv.slice(2);
  if (backendArg === undefined || !isBackend(backendArg)) {
    console.error(`verify-backend-cli: unknown or missing backend "${backendArg ?? ""}"`);
    process.exitCode = 1;
    return;
  }
  const logText = await readStdin();
  const result = backendRan(backendArg, logText);
  const label = service ?? backendArg;
  if (result.ok) {
    console.log(`PASS ${label}: ${result.reason}`);
  } else {
    console.error(`FAIL ${label}: ${result.reason}`);
    process.exitCode = 1;
  }
}

void main();
