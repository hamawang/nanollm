import assert from "node:assert/strict";
import { test } from "node:test";
import { createClient, type Client } from "@libsql/client";
import { inspectStorage, migrateStorage, verifyStorage } from "../scripts/storage-migration.js";

const options = { migrationId: "test-cutover", sourceIdentity: "test-source" };
function db() { return createClient({ url: "file::memory:", intMode: "bigint" }); }
async function seed(source: Client) {
  await source.executeMultiple(`
    CREATE TABLE records (key TEXT PRIMARY KEY, entry_json TEXT NOT NULL);
    CREATE INDEX records_key ON records(key);
    CREATE TABLE record_images (hash TEXT PRIMARY KEY, data_url TEXT NOT NULL);
    CREATE TABLE record_image_refs (record_key TEXT NOT NULL, image_hash TEXT NOT NULL, PRIMARY KEY(record_key, image_hash));
    CREATE TABLE status_buckets (model TEXT NOT NULL, bucket INTEGER NOT NULL, value REAL, PRIMARY KEY(model, bucket));
    CREATE TABLE usage_days (day TEXT NOT NULL, model TEXT NOT NULL, total INTEGER, payload BLOB, PRIMARY KEY(day, model));
  `);
  for (let i = 0; i < 35; i++) await source.execute({ sql: "INSERT INTO records VALUES (?, ?)", args: [String(i).padStart(3, "0"), JSON.stringify({ text: i === 0 ? "large".repeat(250000) : "hello", i })] });
  await source.execute({ sql: "INSERT INTO record_images VALUES (?, ?)", args: ["image", "data:image/png;base64,YWJj"] });
  await source.execute("INSERT INTO record_image_refs VALUES ('000', 'image')");
  await source.execute("INSERT INTO status_buckets VALUES ('model', 1, 1.25)");
  await source.execute({ sql: "INSERT INTO usage_days VALUES (?, ?, ?, ?)", args: ["2026-10-01", "model", 9007199254740993n, new Uint8Array([0, 1, 255])] });
}
function wrapped(client: Client, overrides: Partial<Client>): Client {
  return new Proxy(client, { get(target, key) {
    if (key in overrides) return overrides[key];
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

test("migration preserves tables, indexes, large records, images, blobs and integers without writing source", async () => {
  const source = db(), target = db();
  try {
    await seed(source);
    const before = await inspectStorage(source);
    const readOnly = wrapped(source, {
      execute: async (input: any, args?: any) => {
        const sql = typeof input === "string" ? input : input.sql;
        assert.match(sql, /^(SELECT|PRAGMA table_info)/);
        return typeof input === "string" ? source.execute(input, args) : source.execute(input);
      },
      batch: async () => { throw new Error("Source must not be written"); },
      executeMultiple: async () => { throw new Error("Source must not be written"); },
    });
    const copied = await migrateStorage(readOnly, target, options);
    assert.deepEqual(copied, before);
    await verifyStorage(target, before);
    assert.equal((await target.execute("SELECT total FROM usage_days")).rows[0].total, 9007199254740993n);
    assert.equal((await target.execute("SELECT status FROM nanollm_storage_migration_state")).rows[0].status, "complete");
    await migrateStorage(readOnly, target, options);
    assert.deepEqual(await inspectStorage(source), before);
    await target.execute("UPDATE records SET entry_json = 'tampered' WHERE key = '001'");
    await assert.rejects(migrateStorage(readOnly, target, options), /verification failed/);
  } finally { source.close(); target.close(); }
});

test("interrupted migration resumes without duplicates and never marks failed copy complete", async () => {
  const source = db(), target = db();
  try {
    await seed(source);
    let writes = 0;
    const failing = wrapped(target, { batch: async (statements, mode) => {
      if (++writes === 3) throw new Error("simulated transport failure");
      return target.batch(statements, mode);
    } });
    await assert.rejects(migrateStorage(source, failing, options), /simulated transport failure/);
    assert.equal((await target.execute("SELECT status FROM nanollm_storage_migration_state")).rows[0].status, "copying");
    await migrateStorage(source, target, options);
    assert.equal((await target.execute("SELECT COUNT(*) AS n FROM records")).rows[0].n, 35n);
    await verifyStorage(target, await inspectStorage(source));
  } finally { source.close(); target.close(); }
});

test("migration refuses a populated target without touching its data", async () => {
  const source = db(), target = db();
  try {
    await seed(source);
    await target.executeMultiple("CREATE TABLE owned (id INTEGER PRIMARY KEY); INSERT INTO owned VALUES (1)");
    await assert.rejects(migrateStorage(source, target, options), /not empty/);
    assert.equal((await target.execute("SELECT COUNT(*) AS n FROM owned")).rows[0].n, 1n);
    assert.equal((await target.execute("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name = 'nanollm_storage_migration_state'")).rows[0].n, 0n);
  } finally { source.close(); target.close(); }
});

test("source changes during copying prevent completion and unsafe retries", async () => {
  const source = db(), target = db();
  try {
    await seed(source);
    let changed = false;
    const changing = wrapped(target, { batch: async (statements, mode) => {
      const result = await target.batch(statements, mode);
      if (!changed) { changed = true; await source.execute("UPDATE record_images SET data_url = 'changed' WHERE hash = 'image'"); }
      return result;
    } });
    await assert.rejects(migrateStorage(source, changing, options), /Source changed|verification failed/);
    assert.equal((await target.execute("SELECT status FROM nanollm_storage_migration_state")).rows[0].status, "copying");
    await assert.rejects(migrateStorage(source, target, options), /source differs/);
  } finally { source.close(); target.close(); }
});
