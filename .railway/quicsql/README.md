# Private quicSQL service

This directory is the complete Docker build context for the existing Railway
`sqld` service. It uses quicSQL v0.6.0, fetched from its official release with
the archive SHA-256 verified by Docker. No database or credentials are included
in the build context or image.

Keep the existing volume mounted at `/var/lib/sqld`. quicSQL uses the separate
`quicsql/app.db` file; the former sqld `iku.db` directory is retained for rollback.
The `rwc` mode creates `quicsql/app.db` on a fresh volume for template deployments.
Existing databases are opened without replacing their contents. When migrating,
import and verify the backup before switching the gateway connection.

The listener binds `[::]:8080` for Railway private networking, with `auth: [none]`
and no principals or grants. Do not add a public domain or TCP proxy. Health
checks use `/_health`; libSQL clients use:

```text
http://sqld.railway.internal:8080/app/
```

The database path and trailing slash are required. Keep the application on its
current database until a separate connection cutover is performed.

Deploy only this directory, not the entire nanollm application:

```powershell
railway up .railway/quicsql --path-as-root --detach --service 7a12f90c-0b3a-4db7-a917-4797879a1741 --environment 5b5a8df7-6848-412e-b360-7fa176787894 --project 8cf09d50-22bb-4766-b9f0-dd66df660148
```

The service must use the uploaded Dockerfile build instead of its former sqld
registry-image source, with no start-command override. Its name, volume and
US West region remain the same. Legacy `SQLD_*` variables are ignored by quicSQL.

In the published template this service builds from GitHub `dev`, with the root
directory `/.railway/quicsql` and watch patterns `/.railway/quicsql/**` stored
in the template configuration. Ordinary gateway source changes do not redeploy
that database service. The current production service still uses an uploaded build.

Rollback before application cutover: restore the pinned sqld image from
[`storage-migration.md`](../storage-migration.md), remove the quicSQL healthcheck,
and redeploy using the original volume and sqld variables. After application
cutover, new quicSQL writes must be reconciled before returning to sqld.

References: [official release](https://github.com/quicsql/quicsql/releases/tag/v0.6.0)
and [authentication configuration](https://github.com/quicsql/quicsql/blob/v0.6.0/docs/auth-and-authz.md).
