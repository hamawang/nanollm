import { createClient } from "@libsql/client";

const sourceUrl = process.env.BACKFILL_SOURCE_URL;
const sourceToken = process.env.BACKFILL_SOURCE_AUTH_TOKEN;
const targetUrl = process.env.BACKFILL_TARGET_URL ?? "http://sqld.railway.internal:8080/app/";
if (!sourceUrl) throw new Error("Missing Turso database URL");

const source = createClient({ url: sourceUrl, authToken: sourceToken, intMode: "bigint", readYourWrites: true });
const target = createClient({ url: targetUrl, intMode: "bigint", readYourWrites: true });
const tables = {
  records: ["key", "request_id", "created_at", "path", "model", "actual_model", "source", "status", "response_status", "entry_json"],
  record_images: ["hash", "data_url"],
  record_image_refs: ["record_key", "image_hash"],
  daily_token_summary: ["date_start", "success_requests", "non_cache_input_tokens", "cache_read_input_tokens", "output_tokens"],
  status_buckets: ["model_name", "bucket_start", "total_requests", "success_requests", "total_ttfb_ms", "ttfb_samples", "total_duration_ms", "duration_samples", "total_stream_ms", "stream_samples", "non_cache_input_tokens", "cache_read_input_tokens", "output_tokens", "cache_write_input_tokens"],
  usage_days: ["day", "model_name", "total_requests", "success_requests", "failure_requests", "total_duration_ms", "duration_samples", "non_cache_input_tokens", "cache_read_input_tokens", "output_tokens", "total_tokens", "cache_write_input_tokens"],
};
const keyTables = new Set(["records", "record_images", "record_image_refs"]);
const q = (name) => `"${name.replaceAll('"', '""')}"`;
const printable = (value) => typeof value === "bigint" ? value.toString() : value;

async function rows(client, table, columns) {
  return (await client.execute(`SELECT ${columns.map(q).join(", ")} FROM ${q(table)}`)).rows;
}
async function count(client, table) {
  return String((await client.execute(`SELECT COUNT(*) n FROM ${q(table)}`)).rows[0].n);
}
async function run() {
  const summary = [];
  for (const [table, columns] of Object.entries(tables)) {
    const sourceRows = await rows(source, table, columns);
    const sql = `${keyTables.has(table) ? "INSERT OR IGNORE" : "INSERT OR REPLACE"} INTO ${q(table)} (${columns.map(q).join(",")}) VALUES (${columns.map(() => "?").join(",")})`;
    let changed = 0;
    for (const row of sourceRows) {
      const result = await target.execute({ sql, args: columns.map((column) => row[column]) });
      changed += Number(result.rowsAffected ?? 0);
    }
    const targetCount = await count(target, table);
    summary.push({ table, sourceRows: sourceRows.length, changed, targetCount });
    console.log(`${table}: source=${sourceRows.length}, changed=${changed}, target=${targetCount}`);
  }
  console.log(JSON.stringify({ targetUrl, summary }));
}
try { await run(); } finally { source.close(); target.close(); }
