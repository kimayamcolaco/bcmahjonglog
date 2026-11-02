# Move reservations from KVDB to Supabase

These changes are prepared locally, not deployed. The migration utility never writes to KVDB.
Supabase analytics, the dashboard, and weekly reports stay on their existing tables.

## Use the updated package and the new API keys

Use the refreshed `bcmahjonglog-supabase-fix.zip` in Downloads, not a folder extracted
from the earlier ZIP. This version uses Supabase **Publishable** and **Secret** keys;
do not use the legacy `anon` or `service_role` API keys.

In Supabase, open **Project Settings -> API Keys** (the screen with Publishable key
and Secret keys):

- Copy the **Publishable key**, beginning with `sb_publishable_`.
- Reveal/copy the **Secret key**, beginning with `sb_secret_`, directly into Vercel
  or the private local prompt below. Do not share it in chat or screenshots.
- Under **Project Settings -> Data API**, copy the **Project URL**.

## 1. Protect the existing data

Use Node.js 20 or newer. Run commands from the repository folder in PowerShell.
Temporarily pause booking access during the final backup, migration, and deployment.
Use Vercel deployment protection or another real access restriction: a notice alone does
not stop old browser tabs from writing. The old deployment can otherwise change KVDB
after your snapshot. Do not remove the restriction until verification is complete.

```powershell
New-Item -ItemType Directory -Force backups
node scripts\migrate-bookings.js backup --source https://bcmahjonglog.vercel.app/api/bookings --out backups\cutover.backup.json
node scripts\migrate-bookings.js migrate --file backups\cutover.backup.json
```

The first command saves the full history and a SHA-256 checksum, refusing to overwrite
an existing backup. The second validates it without connecting to Supabase.
If making another snapshot, use a new filename and its matching checksum.
Keep a private second copy of both backup files. They contain names and cancellation
credential hashes; do not upload or commit them. A read-only snapshot taken while the
old site is still open is useful as an initial backup, but is NOT the final cutover snapshot.

## 2. Create the reservation table

In your existing Supabase project, open **SQL Editor**, paste [bookings.sql](./bookings.sql),
and run it. Do **not** rerun [schema.sql](./schema.sql): that file creates the existing analytics tables.

This creates one row per seat, a unique seat constraint, and an atomic change function.
The `anon` and `authenticated` roles have no direct table or function access.
Only the server-side service role can access reservations.
The `anon` and `service_role` names in the SQL are **database roles**, not deprecated
API key formats. The new Publishable and Secret keys map to those roles respectively;
leave the SQL role names as written. If you already ran this file, no SQL changes
are required for the switch to new keys.

## 3. Configure server credentials

In **Vercel -> Project -> Settings -> Environment Variables**, configure:

| Variable | Value | Where used |
| --- | --- | --- |
| `SUPABASE_URL` | Your Supabase project URL | Server and existing analytics configuration |
| `SUPABASE_SECRET_KEY` | Secret key starting with `sb_secret_` | Server-only reservations, weekly report, and local migration |
| `SUPABASE_PUBLISHABLE_KEY` | Publishable key starting with `sb_publishable_` | Browser analytics and dashboard |

Set these for the deployment environments you intend to use (Production and, if needed,
Preview/Development). **Never expose the Secret key through `/api/config`, browser
JavaScript, a `NEXT_PUBLIC_*` variable, source control, screenshots, or chat.**

If you already added `SUPABASE_ANON_KEY` or `SUPABASE_SERVICE_ROLE_KEY` to Vercel,
leave them until the new deployment is verified, then remove those old environment
variables. This code reads only the new names. Do not revoke old keys while the
old deployment is still serving traffic. Keep `CRON_SECRET` unchanged; it authorizes
Vercel's scheduled job and is not a Supabase API key.

For the local migration, set `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in the same
terminal session that runs the migration. To avoid placing the Secret key in command history:

```powershell
$env:SUPABASE_URL = "https://YOUR-PROJECT.supabase.co"
$secureKey = Read-Host "Supabase Secret key (sb_secret_...)" -AsSecureString
$env:SUPABASE_SECRET_KEY = [System.Net.NetworkCredential]::new("", $secureKey).Password
try {
    node scripts\migrate-bookings.js migrate --file backups\cutover.backup.json --apply
    if ($LASTEXITCODE -ne 0) { throw "Migration failed; do not deploy." }
} finally {
    Remove-Item Env:SUPABASE_SECRET_KEY
    Remove-Variable secureKey
}
```

`--apply` is the explicit permission to write Supabase rows. This utility checks existing
destination rows first, inserts only missing IDs in small batches, then reads every row
back and compares its full JSON with the backup. It never overwrites conflicting rows.
If interrupted, it is safe to rerun against the same unchanged backup. A failed batch
can leave earlier batches inserted, but verification will not claim success.

## 4. Test and deploy

```powershell
npm install
npm test
```

The only npm dependency is a **development-only embedded PostgreSQL test database**;
the website and Vercel API still use native JavaScript and `fetch`.
Requests send the new keys in the `apikey` header, not as bearer JWTs in `Authorization`.
`/api/config` returns only the project URL and Publishable key, never the Secret key.

Commit/push the prepared code to your repository when ready, then let Vercel deploy
the commit **after** the migration has verified successfully. Keep the framework preset
as **Other**, output directory as the repository root, and do not add a build command.
For local testing, use `vercel dev` with Development environment variables; a plain
static file server no longer bypasses the server API to write KVDB.

Before lifting the access restriction:

1. Check `/api/bookings` returns HTTP 200 and the migrated full history.
2. Check `/api/bookings?since=YYYY-MM-DD`, using the displayed week's Monday, contains
   the correct current reservations.
3. Check the browser console/network for errors and hard-refresh old tabs.
4. Make one authorized test booking, reload, then cancel it with its Club ID.
5. Verify an incorrect Club ID fails and the reservation remains.
6. Confirm the analytics dashboard and weekly-report configuration still work.
7. Check `/api/config` contains `supabasePublishableKey` beginning with `sb_publishable_`
   and does not contain the Secret key.

The new client sends only added/removed/changed rows, not the entire history. Seat,
table start time, Mahjong type, and four-set limits are checked transactionally.
Background reads normally fetch the displayed week onward; full-history export still
reads all rows with pagination.

**Intentional import change:** importing a backup adds missing bookings and preserves
existing rows. It no longer silently replaces the whole database or deletes reservations.
Conflicting seat occupancy fails rather than overwriting someone else's booking.

Old tabs running the KVDB-era client receive an explicit "reload the app" error from
the new API. Do not try to support those old full-array writes during cutover.

## Rollback

KVDB and the private backup remain untouched. If verification fails **before anyone
uses the new site**, restore the old Vercel deployment and investigate. That restores
the previous KVDB behavior, including its current save failure; it is not a repair.

If bookings have already been accepted in Supabase, do not switch back blindly:
pause access, export the new database, and reconcile additions/cancellations first.
Otherwise a rollback would hide new reservations or resurrect cancelled ones.

## References

- [Booking API](./api/bookings.js)
- [Reservation schema and transaction](./bookings.sql)
- [Backup/migration utility](./scripts/migrate-bookings.js)
- Existing [analytics schema](./schema.sql) and [client](./app.js)
- [Supabase: migrating to Publishable and Secret API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
