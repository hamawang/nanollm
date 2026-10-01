# Turso to self-hosted sqld

The migration CLI is included in the built application image. It is a separate
command and is never run by normal server startup. It does not modify Railway
variables, use forced GC, or write to the source database.

## Commands

Run `npm run migrate:storage -- --help` locally, or
`node dist/scripts/storage-migration-cli.js --help` in a built container.

Supply credentials through environment variables, not command-line arguments:

| Variable | Meaning |
| --- | --- |
| `MIGRATION_SOURCE_URL` | Original Turso database URL |
| `MIGRATION_SOURCE_AUTH_TOKEN` | Original Turso token; preferably read-only |
| `MIGRATION_TARGET_URL` | `http://${{sqld.RAILWAY_PRIVATE_DOMAIN}}:8080` for sqld; quicSQL uses `http://${{sqld.RAILWAY_PRIVATE_DOMAIN}}:8080/app/` |
| `MIGRATION_TARGET_AUTH_TOKEN` | Optional; leave unset for the private sqld service with authentication disabled |
| `MIGRATION_ID` | Unique stable identifier for this cutover; reuse it when retrying |
| `MIGRATION_WRITERS_PAUSED` | Set to `yes` only after all source writers are stopped |

1. `--inspect` reads the source schema and hashes every row. It requires only
   source variables and makes no changes.
2. `--copy` requires an empty compatible target, or a partial target owned by the
   same migration. It copies schema, rows and indexes, verifies content, checks
   the source again, and records completion only after all checks pass.
3. `--verify` reads both databases and compares schema, counts and content.

Rows are fetched one at a time in primary-key order. Write batches are limited
to 25 rows and approximately 1 MiB of serialized row data, except when a single
row is larger. Both servers must permit responses large enough for the largest
individual record or image. No whole-database transaction or snapshot is kept
open across HTTP requests: a live source requires writers to remain paused.
An immutable backup can instead be the source while the application stays online.

Migration metadata (`nanollm_migration_state` and
`nanollm_storage_migration_state`) is not copied. Other user tables and indexes
are copied, provided every table has a non-null primary key. A changed source
or a non-empty unrelated target is rejected. An interrupted migration is
restartable with the same ID and unchanged source; it starts copying again and
upserts rows. It does not clear arbitrary target data.

## Production sequence

1. Keep the original nanollm service and its `/data` volume. Deploy sqld in the
   same project/environment with a new `/var/lib/sqld` volume, IPv6-capable HTTP
   listener and a pinned image. Authentication is disabled for this private service.
   Do not expose it publicly.
2. Back up the original database and `/data`, and retain the original connection
   configuration. Inspect source size and validate connectivity using a temporary
   migration service. Do not switch the application yet.
3. The user requires the application to stay online and accepts missing changes
   made after the backup. Use the already verified immutable backup as the source;
   do not stop nanollm or assert that its live writers are paused.
4. Copy the backup and verify against that backup. Do not compare the target to
   live Turso, which is still changing. On failure retry from the same backup;
   leave the application's connection unchanged.
5. After verification, switch the application URL to sqld, remove its old Turso
   token, and redeploy.
   Remove old alias variables and `NANOLLM_TURSO_AUTO_MIGRATE_FROM` if configured.
6. Verify health, proxying, records/images, status, usage and restart persistence.
   Remove migration credentials/service when finished. Keep the source backup.
7. If target writes have begun, a rollback needs synchronization of those new
   writes before changing back to the old database; changing the URL alone loses
   access to data created after cutover.

## Step 2 deployment completed (2026-10-02)

The existing application still uses Turso. No production data has been copied
and no application connection variables have been changed.

| Resource | Value |
| --- | --- |
| Project | `8cf09d50-22bb-4766-b9f0-dd66df660148` (nanollm) |
| Environment | `5b5a8df7-6848-412e-b360-7fa176787894` (production) |
| sqld service | `7a12f90c-0b3a-4db7-a917-4797879a1741` |
| sqld volume | `c951f9ec-3754-472f-b45d-214025cd5ffc` |
| Mount path | `/var/lib/sqld` |
| Private URL | `http://sqld.railway.internal:8080` |
| Image | `ghcr.io/tursodatabase/libsql-server@sha256:6dd3eb276d9d3604e4a48ac4a999a2e267814732d57d7e94c04ba71482333a67` |
| Server version | `0.24.33` |
| Current region | `us-west2` (same as nanollm; moved on 2026-10-02) |

Server variables are `SQLD_NODE=standalone` and
`SQLD_HTTP_LISTEN_ADDR=[::]:8080`. At the user's request, JWT authentication was
disabled on 2026-10-02 by removing `SQLD_AUTH_JWT_KEY` and
`SQLD_CLIENT_AUTH_TOKEN` and redeploying sqld. No public domain or TCP proxy was
created. The former encrypted local JWT backup was removed as well.

Initial deployment testing verified that a test row survived an sqld restart.
After disabling authentication, private HTTP SQL write/read was verified without
an Authorization header. Test tables were removed after testing.

For the later migration service, use the target URL above and leave
`MIGRATION_TARGET_AUTH_TOKEN` unset. After copying and verification, the
application can use `http://${{sqld.RAILWAY_PRIVATE_DOMAIN}}:8080` and must remove
its old Turso token, including any configured aliases. The application still
uses its original Turso URL/token; this cutover has not been performed yet.

## Step 3 backup and preparation completed (2026-10-02)

The application remained online throughout preparation. These backups precede
the cutover; subsequent application writes are not included. The user subsequently
chose to import this fixed backup without stopping the application, accepting the
missing changes made after it was captured.

Backups are outside Git at
`C:\Users\sunwu\.codex\backups\nanollm-2026-10-02` with Windows filesystem
permissions restricted to the current user:

- `railway-variables.dpapi`: encrypted original Railway variables for rollback;
  decryptable by the current Windows user using DPAPI.
- `data.tar.gz`: `/data` configuration and subscription credentials. Restored
  locally and checked: valid YAML configuration and three valid JSON credential
  files. No local database was present on the application volume.
- `turso.sql`: complete SQL export (150,955,445 bytes). An incomplete first
  download was discarded; only the completed export is retained.
- `turso-snapshot.db`: restored SQLite database (151,183,360 bytes), with
  `PRAGMA integrity_check` returning `ok`.
- `snapshot-manifest.json`, `inspection.json`, `checksums.json`: table schema,
  primary-key migration compatibility, per-table row/content hashes, size
  measurements, and backup SHA-256 checksums.

These files contain production data and secrets; do not commit or print them.
Only the rollback variables are DPAPI encrypted; the data backups rely on the
restricted filesystem permissions.

Snapshot counts:

| Table | Rows |
| --- | ---: |
| records | 100 |
| daily_token_summary | 2 |
| status_buckets | 1506 |
| usage_days | 595 |
| record_image_refs | 0 |
| record_images | 0 |

Record values total 150,574,437 bytes; the largest row contains 4,234,128 bytes
of SQLite values. A live largest-record probe produced a 4,744,019-byte JSON
payload, and its full write/read to sqld succeeded over private HTTP without
authentication. The probe table was removed afterward. No application tables
have been copied to sqld.

The independent temporary `migration` service is ready in the same production
environment, without a volume or public endpoint:

- Service ID: `0511f6ca-eedb-47c4-8666-790906e560ce`.
- Deployment ID: `b1f6ecc1-8cb0-4210-914d-743634b1f0ce`.
- Runtime: `node:24-bookworm-slim`, `@libsql/client` pinned to `0.17.4`, and the
  built migration helper/CLI from this checkout. Its default process is idle;
  it does not start nanollm or perform migration automatically.
- `MIGRATION_SOURCE_URL=${{nanollm.NANOLLM_TURSO_DATABASE_URL}}`.
- `MIGRATION_SOURCE_AUTH_TOKEN=${{nanollm.NANOLLM_TURSO_AUTH_TOKEN}}`.
- `MIGRATION_TARGET_URL=http://${{sqld.RAILWAY_PRIVATE_DOMAIN}}:8080`.
- No target token and no `MIGRATION_WRITERS_PAUSED` flag have been set.

Its CLI path is `node scripts/storage-migration-cli.js` (the minimal runner
contains built JavaScript directly in `/app/scripts`). The original application
image does not yet contain the new migration CLI. Keep the migration service's
source variable references intact until verification is complete, before changing
the application's URL/token. Remove the temporary service after the migration.

The initial plan called for stopping writers, but the user superseded it with
an online migration from the existing immutable backup. No application stop or
URL/token switch is required for importing the backup. Do not set the live-writer
pause flag for this operation; use the migration library with the backup client.

## Step 4 immutable backup imported and verified (2026-10-02)

At the user's request nanollm remained online throughout this operation. Its
deployment and database variables were not changed. The source was the restored
backup, not live Turso; writes made after the backup are absent from this import.

The SQLite backup was uploaded to `/app/source-snapshot.db` on the temporary
migration service. Its SHA-256 matched the original backup before and after
import: `7053626c539efabbdd154d85af768b4e11c1d677262a2ae747a1e8ab19fc6c5d`.
The migration library was invoked directly with a local-file source client and
the private sqld target client. No live-writer pause flag was asserted and the
operation did not connect to live Turso.

All six business tables (2,203 rows total) and six explicit indexes were copied.
Schema, counts and SHA-256 content digests matched the immutable backup for each
table, and the source was checked again. The target's migration state is
`complete` for ID `nanollm-backup-20261002-7053626c539e`. The old local-to-Turso
migration metadata was excluded; the new migration has its own state table.

The result report is saved alongside the local backups as
`sqld-migration-result.json`; its manifest also matches the originally saved
`snapshot-manifest.json`. The invocation script is saved there as
`snapshot-migrate.mjs`. The temporary migration service and its uploaded snapshot
are retained for the remaining cutover work; do not redeploy that temporary
service if relying on its ephemeral snapshot. Do not invoke its ordinary CLI
against the still-live source references to overwrite the imported snapshot.

Next: plan the connection switch under the user's no-service-interruption
constraint. No application cutover has occurred; nanollm still writes to Turso.

## sqld moved to US West (2026-10-02)

The sqld service was initially created in the default Singapore region
`asia-southeast1-eqsg3a`. It has now been moved, together with its existing
volume, to `us-west2`, matching the running nanollm service. There is one sqld
replica in US West and none in Singapore. The sqld deployment is
`70c2bf2f-cdb3-4a91-ad8c-5768a2e8fa85` (`SUCCESS`), and the original volume ID
`c951f9ec-3754-472f-b45d-214025cd5ffc` is `Ready` at `/var/lib/sqld`.

After relocation, verification from the running nanollm container confirmed all
six business tables, six explicit indexes, row counts, full content hashes and
the migration completion marker against the saved backup manifest.

Private `SELECT 1` measurements from nanollm:

- Before relocation, HTTP requests after the first connection: 180–183 ms.
- After relocation, eight warmed libSQL client queries: 6, 5, 5, 5, 4, 4, 5, 5 ms.
- A separate HTTP fetch probe: 73, 30, 6, 9, 5, 5, 5, 69 ms (including first
  connection and occasional outliers).

The nanollm deployment was not changed or stopped and still connects to Turso.
The temporary migration service remains in Singapore; it is not in the
application's future database request path. No application cutover has occurred.

## Cost review after relocation (2026-10-02)

The connection switch is deferred pending a cost assessment. An idle sqld sample
after relocation showed container memory of 102,035,456 bytes, process RSS of
68,000 KiB, and 49,557,504 bytes of file cache. This sample is not a monthly
average or a bound under application traffic. At Railway's published $10 per
GB-month RAM rate, sustained billable usage around 100/200 MB would add roughly
$1/$2 per month, before CPU and storage. Dashboard peaks alone do not establish
the future monthly bill or the exact cache treatment in billing.

Only traffic previously sent to external Turso can be removed by this private
database arrangement; client-facing proxy egress remains. The extra database
cost therefore must be compared with that specific egress saving before cutover.

The completed temporary `migration` deployment was removed to avoid ongoing
compute charges. Its service record remains for reuse. Treat its uploaded
ephemeral snapshot as unavailable after shutdown; the verified source backups,
invocation script and migration result remain in the restricted local backup
directory. The original nanollm service and the sqld volume were not stopped or
deleted by this cleanup.

## Local sqld / quicSQL comparison completed (2026-10-02)

See [the comparison report](sqlite-http-comparison.md) and its two metric JSON
files for reproducible tests using the immutable backup. Both servers passed
protocol, transaction, full-content and restart checks in both rounds. quicSQL
used less process memory after large-record workloads (47–52 MiB RSS versus
109–112 MiB) and its data directory stabilized around 174 MiB during the
1,000-write / retain-100 test. Container file-cache accounting varied, so these
results do not establish Railway billing savings or a monthly budget guarantee.

quicSQL remains a local replacement candidate pending actual nanollm integration
tests. It has not been deployed to production. The application still uses Turso,
and the already imported production sqld database has not been changed by these
benchmarks.

## Database service replaced with quicSQL (2026-10-02)

At the user's request, the existing `sqld` service now runs quicSQL v0.6.0 from
the Docker build context in [`quicsql/`](quicsql/README.md). Its deployment ID is
`2041fa41-848a-441f-99af-45aab163d541`. The official registry image was not used;
the Dockerfile downloads the official release archive and verifies its SHA-256.
The resulting image contains no production database or credentials.

The service ID, `us-west2` region, original volume ID and `/var/lib/sqld` mount
remain unchanged. The verified immutable backup was uploaded separately to
`/var/lib/sqld/quicsql/app.db`; its SHA-256 matched the original before startup.
The former sqld data under `iku.db` remains intact for rollback. quicSQL opens
the seeded database in `rw` mode, so a missing seed does not silently create an
empty application database.

The IPv6-capable HTTP listener is `[::]:8080`, explicitly `auth: [none]`, with
no principals or grants. There is no public domain or TCP proxy. Health checks
use `/_health`. The client URL is now:

```text
http://sqld.railway.internal:8080/app/
```

For a future application cutover, use
`http://${{sqld.RAILWAY_PRIVATE_DOMAIN}}:8080/app/` and remove the old Turso token
and its aliases. The trailing slash and database path must be retained.

After deployment, a client in the existing nanollm container verified all six
business tables, 2,203 rows, six explicit indexes and full content hashes against
the saved backup, then successfully wrote a probe without an authentication
header. The nanollm deployment and connection variables were not changed;
the gateway still uses Turso. The data still represents the fixed backup rather
than later live Turso writes.

## Current cutover and template publication (2026-10-02)

The preceding sections are chronological snapshots. The gateway has since switched
to `http://sqld.railway.internal:8080/app/`; a best-effort backfill was run for the
later Turso interval. Before publishing the generic SQLite refactor, the live gateway
was given `NANOLLM_SQLITE_URL` with that same private address using skip-deploys.
The legacy URL was retained for the running old image until replacement succeeds.
New code uses `NANOLLM_SQLITE_URL` and optional `NANOLLM_SQLITE_AUTH_TOKEN` only;
startup no longer performs implicit database migrations.

The published template now contains two services and two volumes, both in US West,
using the repository's `dev` branch. New template databases use `rwc` and no auth,
with no public database domain. Current uploaded production quicSQL is unchanged.
After two days, compare average billable RAM, CPU, disk and egress with Turso.
If returning to Turso, first reconcile new quicSQL data; do not simply restore
the previous connection URL and lose records written after cutover.
