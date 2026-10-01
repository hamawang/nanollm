import "dotenv/config";
import { createClient, type Client } from "@libsql/client";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { migrateSqliteFileToTurso } from "./turso-migration.js";

type CliOptions = {
  from?: string;
  url?: string;
  token?: string;
};

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--from" && next) {
      options.from = next;
      index += 1;
    } else if (arg.startsWith("--from=")) {
      options.from = arg.slice("--from=".length);
    } else if (arg === "--url" && next) {
      options.url = next;
      index += 1;
    } else if (arg.startsWith("--url=")) {
      options.url = arg.slice("--url=".length);
    } else if (arg === "--token" && next) {
      options.token = next;
      index += 1;
    } else if (arg.startsWith("--token=")) {
      options.token = arg.slice("--token=".length);
    }
  }
  return options;
}

function resolveRemoteConfig(options: CliOptions) {
  const url = options.url ?? process.env.NANOLLM_SQLITE_URL;
  const authToken = options.token ?? process.env.NANOLLM_SQLITE_AUTH_TOKEN;
  if (!url) {
    throw new Error("Missing SQLite database URL. Pass --url or set NANOLLM_SQLITE_URL.");
  }
  return { url, authToken };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.from) {
    throw new Error("Missing source sqlite path. Pass --from /path/to/nanollm.sqlite3.");
  }

  const sourcePath = resolve(process.cwd(), options.from);
  if (!existsSync(sourcePath)) {
    throw new Error(`Source sqlite file not found: ${sourcePath}`);
  }

  const remote = resolveRemoteConfig(options);
  const target = createClient({ url: remote.url, authToken: remote.authToken, intMode: "number", readYourWrites: true });

  try {
    await migrateSqliteFileToTurso(target, sourcePath, { logger: console.log });
    console.log(`Migration complete: ${sourcePath} -> ${remote.url}`);
  } finally {
    target.close();
  }
}

await main();
