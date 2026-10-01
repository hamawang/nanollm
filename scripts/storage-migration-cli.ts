import { createClient } from "@libsql/client";
import { createHash } from "node:crypto";
import { inspectStorage, migrateStorage, verifyStorage, StorageMigrationError } from "./storage-migration.js";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new StorageMigrationError(`Missing ${name}`);
  return value;
}
function identity(raw: string) {
  const url = new URL(raw.replace(/^libsql:/, "https:"));
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.href;
}
async function main() {
  const mode = process.argv[2];
  if (!["--inspect", "--copy", "--verify"].includes(mode)) {
    console.log("Usage: node dist/scripts/storage-migration-cli.js --inspect|--copy|--verify\nSet MIGRATION_SOURCE_URL / MIGRATION_SOURCE_AUTH_TOKEN and MIGRATION_TARGET_URL / MIGRATION_TARGET_AUTH_TOKEN. --copy also requires MIGRATION_ID and MIGRATION_WRITERS_PAUSED=yes.");
    if (mode && mode !== "--help") process.exitCode = 1;
    return;
  }
  const sourceUrl = required("MIGRATION_SOURCE_URL");
  const targetUrl = mode !== "--inspect" ? required("MIGRATION_TARGET_URL") : undefined;
  if (targetUrl && identity(sourceUrl) === identity(targetUrl)) throw new StorageMigrationError("Source and target URLs must differ");
  if (mode === "--copy" && process.env.MIGRATION_WRITERS_PAUSED !== "yes") throw new StorageMigrationError("Pause all application writers, then set MIGRATION_WRITERS_PAUSED=yes");
  const migrationId = mode === "--copy" ? required("MIGRATION_ID") : undefined;
  const source = createClient({ url: sourceUrl, authToken: process.env.MIGRATION_SOURCE_AUTH_TOKEN, intMode: "bigint" });
  const target = targetUrl ? createClient({ url: targetUrl, authToken: process.env.MIGRATION_TARGET_AUTH_TOKEN, intMode: "bigint", readYourWrites: true }) : undefined;
  try {
    const manifest = mode === "--copy" ? await migrateStorage(source, target!, {
      migrationId: migrationId!, sourceIdentity: createHash("sha256").update(identity(sourceUrl)).digest("hex"), logger: console.log,
    }) : await inspectStorage(source);
    if (mode === "--verify") await verifyStorage(target!, manifest);
    for (const table of manifest.tables) console.log(`${table.name}: ${table.rows} rows; SHA-256 ${table.sha256}`);
    if (mode === "--verify") console.log("Verification passed");
  } finally { source.close(); target?.close(); }
}
main().catch((error) => {
  // Transport errors can contain credentials or query payloads. Keep credentials
  // out of logs; library callers still receive the original diagnostic error.
  console.error(error instanceof StorageMigrationError ? error.message
    : "Migration failed while accessing a database. Check connectivity, credentials and server limits. Query payloads and transport errors are omitted to protect credentials.");
  process.exitCode = 1;
});
