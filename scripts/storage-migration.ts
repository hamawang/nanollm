import { createHash } from "node:crypto";
import type { Client, InValue, Row } from "@libsql/client";

const STATE_TABLE = "nanollm_storage_migration_state";
const EXCLUDED_TABLES = new Set([STATE_TABLE, "nanollm_migration_state"]);
const BATCH_BYTES = 1024 * 1024;
const BATCH_ROWS = 25;
type SchemaObject = { name: string; sql: string };
type Column = { name: string; type: string; notnull: number; dflt_value: unknown; pk: number };
export type TableManifest = { name: string; sql: string; columns: Column[]; rows: number; sha256: string };
export type StorageManifest = { tables: TableManifest[]; indexes: SchemaObject[] };
type Options = { migrationId: string; sourceIdentity: string; logger?: (message: string) => void };
export class StorageMigrationError extends Error {}

function ident(value: string) { return `"${value.replace(/"/g, '""')}"`; }
function canonical(value: unknown): unknown {
  if (typeof value === "bigint") return ["integer", value.toString()];
  if (value instanceof ArrayBuffer) return ["blob", Buffer.from(value).toString("base64")];
  if (value instanceof Uint8Array) return ["blob", Buffer.from(value).toString("base64")];
  return value;
}
async function schema(client: Client, type: "table" | "index") {
  const result = await client.execute({ sql: "SELECT name, sql FROM sqlite_schema WHERE type = ? AND name NOT LIKE 'sqlite_%' AND sql IS NOT NULL ORDER BY name", args: [type] });
  return result.rows.map((row) => ({ name: String(row.name), sql: String(row.sql) }))
    .filter((item) => !EXCLUDED_TABLES.has(item.name));
}
async function columns(client: Client, name: string): Promise<Column[]> {
  return (await client.execute(`PRAGMA table_info(${ident(name)})`)).rows.map((row) => ({
    name: String(row.name), type: String(row.type), notnull: Number(row.notnull),
    dflt_value: row.dflt_value, pk: Number(row.pk),
  }));
}

// Fetch one full row at a time. Records and images can be much larger than their
// summaries; a fixed row-count page can otherwise allocate hundreds of MB.
async function* tableRows(client: Client, table: { name: string; columns: Column[] }) {
  const primary = table.columns.filter((column) => column.pk).sort((a, b) => a.pk - b.pk);
  if (!primary.length) throw new StorageMigrationError(`Table ${table.name} needs a primary key for deterministic migration`);
  const keys = primary.map((column) => ident(column.name)).join(", ");
  const fields = table.columns.map((column) => ident(column.name)).join(", ");
  let last: InValue[] | undefined;
  while (true) {
    const where = last ? `WHERE (${keys}) > (${last.map(() => "?").join(", ")})` : "";
    const row = (await client.execute({
      sql: `SELECT ${fields} FROM ${ident(table.name)} ${where} ORDER BY ${keys} LIMIT 1`, args: last ?? [],
    })).rows[0];
    if (!row) return;
    last = primary.map((column) => row[column.name]);
    if (last.some((value) => value == null)) throw new StorageMigrationError(`NULL primary key in ${table.name}`);
    yield row;
  }
}
function rowJson(row: Row, table: { columns: Column[] }) {
  return JSON.stringify(table.columns.map((column) => canonical(row[column.name])));
}
async function digest(client: Client, table: { name: string; columns: Column[] }) {
  const hash = createHash("sha256");
  let rows = 0;
  for await (const row of tableRows(client, table)) { hash.update(rowJson(row, table)).update("\n"); rows++; }
  return { rows, sha256: hash.digest("hex") };
}
export async function inspectStorage(client: Client): Promise<StorageManifest> {
  const tables: TableManifest[] = [];
  for (const table of await schema(client, "table")) {
    const cols = await columns(client, table.name);
    tables.push({ ...table, columns: cols, ...await digest(client, { name: table.name, columns: cols }) });
  }
  if (!tables.length) throw new StorageMigrationError("Source database has no application tables");
  return { tables, indexes: await schema(client, "index") };
}
export async function verifyStorage(client: Client, expected: StorageManifest) {
  const actual = await inspectStorage(client);
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new StorageMigrationError("Database verification failed: schema, row counts or SHA-256 digests differ");
  return actual;
}

async function copyTable(source: Client, target: Client, table: TableManifest) {
  const fields = table.columns.map((column) => ident(column.name)).join(", ");
  const sql = `INSERT OR REPLACE INTO ${ident(table.name)} (${fields}) VALUES (${table.columns.map(() => "?").join(", ")})`;
  let batch: { sql: string; args: InValue[] }[] = [];
  let bytes = 0;
  const hash = createHash("sha256");
  let count = 0;
  async function flush() { if (batch.length) await target.batch(batch, "write"); batch = []; bytes = 0; }
  for await (const row of tableRows(source, table)) {
    const serialized = rowJson(row, table);
    const size = Buffer.byteLength(serialized);
    if (bytes + size > BATCH_BYTES || batch.length >= BATCH_ROWS) await flush();
    batch.push({ sql, args: table.columns.map((column) => row[column.name]) });
    bytes += size;
    hash.update(serialized).update("\n"); count++;
    if (bytes >= BATCH_BYTES) await flush();
  }
  await flush();
  if (count !== table.rows || hash.digest("hex") !== table.sha256) throw new StorageMigrationError(`Source changed while copying ${table.name}; pause all writers before retrying`);
}

export async function migrateStorage(source: Client, target: Client, options: Options) {
  if (source === target) throw new StorageMigrationError("Source and target must be different clients");
  if (!options.migrationId || !options.sourceIdentity) throw new StorageMigrationError("migrationId and sourceIdentity are required");
  const log = options.logger ?? (() => {});
  const manifest = await inspectStorage(source);
  const targetTables = await schema(target, "table");
  const hasState = (await target.execute({ sql: "SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?", args: [STATE_TABLE] })).rows.length > 0;
  const previous = hasState ? (await target.execute({ sql: `SELECT * FROM ${ident(STATE_TABLE)} WHERE migration_id = ?`, args: [options.migrationId] })).rows[0] : undefined;
  if (previous) {
    if (previous.source_identity !== options.sourceIdentity || previous.manifest_json !== JSON.stringify(manifest)) {
      throw new StorageMigrationError("Migration source differs from the saved manifest; refusing to overwrite target");
    }
    if (previous.status === "complete") { await verifyStorage(target, manifest); log("Already migrated; verification passed"); return manifest; }
  } else {
    if (hasState && (await target.execute(`SELECT COUNT(*) AS n FROM ${ident(STATE_TABLE)}`)).rows[0].n != 0) {
      throw new StorageMigrationError("Target belongs to another migration");
    }
    for (const table of targetTables) {
      if ((await target.execute(`SELECT COUNT(*) AS n FROM ${ident(table.name)}`)).rows[0].n != 0) {
        throw new StorageMigrationError(`Target table ${table.name} is not empty; refusing to overwrite existing data`);
      }
      const expected = manifest.tables.find((item) => item.name === table.name);
      if (!expected || expected.sql !== table.sql) throw new StorageMigrationError(`Target schema differs for ${table.name}`);
    }
    await target.executeMultiple(`CREATE TABLE IF NOT EXISTS ${ident(STATE_TABLE)} (
      migration_id TEXT PRIMARY KEY, source_identity TEXT NOT NULL, manifest_json TEXT NOT NULL,
      status TEXT NOT NULL, completed_at INTEGER
    )`);
    await target.execute({ sql: `INSERT INTO ${ident(STATE_TABLE)} VALUES (?, ?, ?, 'copying', NULL)`, args: [options.migrationId, options.sourceIdentity, JSON.stringify(manifest)] });
  }
  for (const table of manifest.tables) {
    const existing = (await schema(target, "table")).find((item) => item.name === table.name);
    if (existing) {
      if (existing.sql !== table.sql) throw new StorageMigrationError(`Target schema differs for ${table.name}`);
    } else await target.executeMultiple(table.sql);
  }
  for (const table of manifest.tables) { await copyTable(source, target, table); log(`Copied ${table.name}: ${table.rows} rows`); }
  for (const index of manifest.indexes) await target.executeMultiple(index.sql.replace(/^CREATE\s+(UNIQUE\s+)?INDEX\s+/i, (_match, unique) => `CREATE ${unique ?? ""}INDEX IF NOT EXISTS `));
  // Compare every value, not just row counts. Re-read the source too, to detect
  // writes that happened after an earlier table was copied.
  await verifyStorage(target, manifest);
  await verifyStorage(source, manifest);
  await target.execute({ sql: `UPDATE ${ident(STATE_TABLE)} SET status = 'complete', completed_at = ? WHERE migration_id = ?`, args: [Date.now(), options.migrationId] });
  log("Migration complete: all tables and indexes verified");
  return manifest;
}
