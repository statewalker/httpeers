/**
 * The storage adapter, from the environment. The ONLY module that knows which
 * backend is in use.
 *
 * THIS IS WHY AN ALPHA OBJECT STORE IS AN ACCEPTABLE RISK. Everything above
 * this file sees `FilesApi` and nothing else, so replacing RustFS with Garage,
 * SeaweedFS, MinIO or real S3 is a change to these environment variables. The
 * coupling that would make that choice dangerous does not exist.
 */
import { S3Client } from "@aws-sdk/client-s3";
import type { FilesApi } from "@statewalker/webrun-files";
import { MemFilesApi } from "@statewalker/webrun-files-mem";
import { NodeFilesApi } from "@statewalker/webrun-files-node";
import { S3FilesApi } from "@statewalker/webrun-files-s3";

/**
 * Read the variables an adapter cannot start without, naming EVERY missing one.
 *
 * ALL AT ONCE, NOT ONE AT A TIME. Failing on the first absent variable makes
 * bringing a deployment up a guessing game -- fix one, restart, learn the next
 * name -- and it makes the error depend on the order this file happens to read
 * them in, which is not a property worth having. A container that starts
 * without its storage configured reports healthy and 404s every request, which
 * looks like missing content rather than missing configuration, so this throws
 * at startup and says exactly what to set.
 */
function requireEnv(env: NodeJS.ProcessEnv, names: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of names) {
    const value = env[name];
    if (value == null || value === "") missing.push(name);
    else values[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `sites: ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} required for ` +
        `SITES_ADAPTER=${env.SITES_ADAPTER}`,
    );
  }
  return values;
}

export function createFilesApi(env: NodeJS.ProcessEnv): FilesApi {
  const adapter = env.SITES_ADAPTER ?? "s3";

  switch (adapter) {
    case "mem":
      return new MemFilesApi();

    case "node":
      return new NodeFilesApi({ rootDir: requireEnv(env, ["SITES_ROOT"]).SITES_ROOT });

    case "s3": {
      const config = requireEnv(env, [
        "S3_ENDPOINT",
        "S3_BUCKET",
        "S3_ACCESS_KEY_ID",
        "S3_SECRET_ACCESS_KEY",
      ]);
      const client = new S3Client({
        endpoint: config.S3_ENDPOINT,
        region: env.S3_REGION ?? "us-east-1",
        credentials: {
          accessKeyId: config.S3_ACCESS_KEY_ID,
          secretAccessKey: config.S3_SECRET_ACCESS_KEY,
        },
        // REQUIRED for RustFS and every other self-hosted S3. Virtual-host
        // addressing would try to resolve `<bucket>.rustfs` as a hostname,
        // which does not exist on the docker network.
        forcePathStyle: true,
      });
      return new S3FilesApi({
        client,
        bucket: config.S3_BUCKET,
        prefix: env.S3_PREFIX,
      });
    }

    default:
      throw new Error(`sites: unknown SITES_ADAPTER "${adapter}" (expected s3, node or mem)`);
  }
}
