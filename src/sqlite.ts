import { createClient, type Client, type ResultSet } from "@libsql/client";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export type SqliteClient = Client;
const clientWriteChains = new WeakMap<SqliteClient, Promise<void>>();

export interface RemoteSqliteConfig {
  url: string;
  authToken?: string;
}

export interface SqliteStorageConnection {
  client: SqliteClient;
  driver: "local" | "remote";
  location: string;
}

export function resolveSqliteConfig(env: NodeJS.ProcessEnv = process.env): RemoteSqliteConfig | undefined {
  const url = env.NANOLLM_SQLITE_URL;
  const authToken = env.NANOLLM_SQLITE_AUTH_TOKEN;
  if (!url && !authToken) return undefined;
  if (!url) {
    throw new Error("SQLite auth token is set but database URL is missing. Set NANOLLM_SQLITE_URL.");
  }
  return { url, authToken };
}

export async function openSqliteStorage(dbPath: string, remote = resolveSqliteConfig()): Promise<SqliteStorageConnection> {
  const location = remote?.url ?? dbPath;
  if (/^(?:https?|libsql|wss?):\/\//i.test(location)) {
    const client = createClient({
      url: location,
      authToken: remote?.authToken,
      intMode: "number",
      readYourWrites: true,
    });
    return {
      client,
      driver: "remote",
      location,
    };
  }

  const localPath = location.startsWith("file:") ? fileURLToPath(location) : location;
  mkdirSync(dirname(localPath), { recursive: true });
  const client = createClient({
    url: pathToFileURL(localPath).href,
    intMode: "number",
    timeout: 5000,
  });
  await client.executeMultiple(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = 5000;
  `);
  return {
    client,
    driver: "local",
    location: localPath,
  };
}

export function firstRow<T extends Record<string, unknown>>(result: ResultSet): T | undefined {
  return result.rows[0] as unknown as T | undefined;
}

export function allRows<T extends Record<string, unknown>>(result: ResultSet): T[] {
  return result.rows as unknown as T[];
}

export function enqueueClientWrite(client: SqliteClient, task: () => Promise<void>) {
  const current = clientWriteChains.get(client) ?? Promise.resolve();
  const next = current.then(task, task);
  clientWriteChains.set(client, next.catch(() => {}));
  return next;
}

export async function waitForClientWrites(client: SqliteClient) {
  await (clientWriteChains.get(client) ?? Promise.resolve());
}
