# Bangalore Club Mahjong Log

The site uses Vercel serverless functions and Supabase. It has no production npm
dependencies and no frontend build step.

## Migrating existing reservations

Reservations now use private, individual Supabase rows through `/api/bookings`, instead
of rewriting one ever-growing KVDB value. **Before deploying this version, follow
[MIGRATION.md](./MIGRATION.md)** to back up KVDB, create the reservation schema, configure
the new API keys, and verify the migrated history. Do not deploy an empty destination.

## Configuration: new Supabase API keys

Open **Supabase -> Project Settings -> API Keys** and use the Publishable and Secret
keys shown on that page, not the legacy API keys.

Set these in **Vercel -> Project -> Settings -> Environment Variables**:

| Variable | Value | Used by |
| --- | --- | --- |
| `SUPABASE_URL` | Project URL from Supabase Data API settings | Server and browser public configuration |
| `SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` | Browser analytics and dashboard |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` | Server reservation API, weekly report, local migration |

Keep the Secret key out of source control, browser code, screenshots, and chat.
`/api/config` returns only the URL and Publishable key. Requests to Supabase send the
new keys in the `apikey` header; these keys are not bearer JWTs.

If older environment variables are present, retain them until the new deployment is
verified, then remove `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`. This version
uses only the new names. Keep `CRON_SECRET` unchanged; it is separate from Supabase keys.
Do not revoke legacy keys until any other integrations using them have also migrated.

## Database setup

- **Existing project:** run [bookings.sql](./bookings.sql) to add reservation storage.
  Leave the existing analytics tables in place; do not rerun their creation statements.
- **New project:** run [schema.sql](./schema.sql) for analytics, then
  [bookings.sql](./bookings.sql) for reservations.

### Reservations

`mahjong_bookings` stores one JSON booking per seat. The API applies deltas atomically,
compares expected old rows before deleting/replacing them, and checks seat uniqueness,
table start times, Mahjong type, and the four-Club-Set limit. Club ID checks remain
required for cancellation. Imports add missing records without overwriting existing ones.

Anonymous browser database access is disabled for this table and its mutation function.
The Secret key maps to the PostgreSQL `service_role` role. That role name remains valid:
it is not the deprecated API key format, so do not rename it in SQL.

### Analytics and weekly reports

- `usage_events` records `event_type`, `metadata`, and `created_at`.
- `weekly_stats_history` stores weekly summary statistics.
- The client logs `booking_created` and `booking_cancelled` events with the Publishable
  key after successful reservation changes.
- The dashboard loads its URL and Publishable key from `/api/config`, then reads the
  analytics tables with `x-is-dashboard: true`.
- Existing analytics RLS policies refer to the PostgreSQL `anon` role, which the new
  Publishable key still uses. The dashboard header is a client convention, not user
  authentication or protection against a determined reader.
- The weekly report reads events and writes summaries using the server-only Secret key.
  Its Vercel schedule and `CRON_SECRET` configuration are unchanged.

## Local development and validation

Use Node.js 20 or newer:

```powershell
npm install
npm test
```

The only npm dependency is a development-only embedded PostgreSQL test database.
Tests cover the API, client, transactions, migration, and new-key header behavior without
writing to production.

Use `vercel dev` with Development environment variables to run the site locally.
A plain static file server cannot serve `/api/bookings` or `/api/config`.
In Vercel use framework preset **Other**, the repository root as the output directory,
and no build command.

Open `/dashboard` on the deployed site or local Vercel development server to view the
analytics charts. Hard-refresh old browser tabs after deployment.

## References

- [Migration and rollback guide](./MIGRATION.md)
- [Supabase: migrating to Publishable and Secret API keys](https://supabase.com/docs/guides/getting-started/migrating-to-new-api-keys)
