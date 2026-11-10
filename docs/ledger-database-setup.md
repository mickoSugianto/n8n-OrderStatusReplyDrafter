# Ledger Database Setup

This guide explains how to provision or upgrade the PostgreSQL idempotency and recovery ledger in Supabase and connect it to n8n.

The canonical setup script [`database/order-status-ledger.sql`](../database/order-status-ledger.sql) is a standalone transactional script for new deployments. It creates a single table (`public.order_status_ledger`, including the `recovery_attempts` counter), enables Row-Level Security (RLS), creates a least-privilege login role (`order_status_ledger`), and defines five `SECURITY INVOKER` RPC functions:
- `public.claim_order_status_request(jsonb)` — atomic first claim (`ON CONFLICT DO NOTHING`)
- `public.checkpoint_order_status_request(jsonb)` — conditional phase progression, immutable `DraftIntentRecorded` self-check, and failure status recording (`NeedsRecovery` when `recovery_attempts = 0` vs. `NeedsInspection` when `inspection = 'true'` or `recovery_attempts >= 1`)
- `public.quarantine_order_status_request(jsonb)` — minimal-CAS pre-transfer quarantine (`status = 'NeedsInspection'`) for permanent pre-claim recovery errors
- `public.recover_order_status_request(jsonb)` — 5-field CAS ownership transfer, enforcing `max_attempts = 1` for `mode = 'auto'` (unrestricted for `mode = 'manual'`) and supporting both `DraftIntentRecorded` adoption (`draft_verified = 'true'`) and recreate-from-intent (`draft_absent_verified = 'true'`)
- `public.find_recoverable_order_status_requests(jsonb)` — pure read-only (`SELECT`) candidate discovery after cooldown (`cooldown_seconds`, default `300`s, floor `90`s) for the scheduled recovery sweeper

For existing deployments created before automated recovery, use the idempotent upgrade script [`database/migrate-automated-recovery.sql`](../database/migrate-automated-recovery.sql).

---

## Prerequisites & Project Settings

1. Create a **dedicated Supabase project** for this ledger.
2. In Supabase Project Settings:
   - Keep **Data API** and **automatic table exposure** **OFF** (the workflow connects over direct/pooled Postgres TLS, not PostgREST).
   - **Automatic RLS** may remain **ON** (the setup script explicitly enables RLS and defines the policy for `order_status_ledger`).

---

## Step-by-Step Setup

### 1. Run the Ledger Setup or Migration SQL
1. Open the Supabase **SQL Editor** (runs as the administrative `postgres` user).
2. Choose the script matching your deployment state:
   - **New deployment (empty database):** Paste and execute [`database/order-status-ledger.sql`](../database/order-status-ledger.sql). It runs inside a single transaction (`BEGIN ... COMMIT`) and is **create-only** (intentionally aborting if `order_status_ledger` or any of the five functions already exist). Never drop an existing ledger table to re-run the script, as deleting completed keys makes previously processed emails eligible again.
   - **Upgrading an existing deployment:** Paste and execute [`database/migrate-automated-recovery.sql`](../database/migrate-automated-recovery.sql). It runs inside a single transaction (`BEGIN ... COMMIT`), idempotently adds `recovery_attempts integer not null default 0 check (recovery_attempts >= 0)` via `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, creates or replaces the checkpoint, quarantine, recovery, and candidate-discovery RPCs, and updates function `REVOKE`/`GRANT EXECUTE` permissions for `order_status_ledger` without touching existing rows.

### 2. Set a Password for the Runtime Role
1. Generate a strong password privately (skip if upgrading an existing deployment that already has a configured role password).
2. In the Supabase SQL Editor, assign the password to the restricted role:
   ```sql
   ALTER ROLE order_status_ledger PASSWORD '<your-strong-password>';
   ```
   *Never commit this password to version control or store it in workflow expressions.*

### 3. Create the Postgres Credential in n8n
In your n8n project, create a **Postgres** credential named **`OrderStatusLedger`** with the following settings from Supabase Connect (**Session pooler** recommended for IPv4):

| Field | Value |
| --- | --- |
| **Host** | Your Supabase pooler host (or direct host) |
| **Database** | `postgres` |
| **User** | `order_status_ledger.<project-ref>` (or `order_status_ledger` for direct connections) |
| **Password** | The password set in Step 2 (do **not** use the admin `postgres` password) |
| **Port** | `5432` |
| **SSL** | Enabled with server-certificate verification |

Bind this `OrderStatusLedger` credential to all Postgres ledger nodes in `DraftOrderStatusReply` (including `QuarantineRecoveryRequest`) and to `FindRecoverableRequests` in `RecoverOrderStatusRequest`.

### 4. Run the Read-Only Preflight Check (18 Boolean Checks)
Execute [`database/verify-order-status-ledger.sql`](../database/verify-order-status-ledger.sql) in the Supabase SQL Editor or via a Postgres node bound to `OrderStatusLedger` in n8n.

Verify that all **18 boolean check columns** return `true`:
- `dedicated_role` and `restricted_role`: `order_status_ledger` exists as a login role without superuser, `CREATEDB`, `CREATEROLE`, or `BYPASSRLS` privileges.
- `schema_usage` and `no_schema_create`: `USAGE` on `public` is granted while `CREATE` is denied.
- `can_read_ledger`, `can_claim`, `can_checkpoint`, and `no_delete`: `SELECT`, `INSERT`, and `UPDATE` are granted on `public.order_status_ledger`, while `DELETE` is denied.
- `rls_enabled`, `no_anonymous_read`, `no_client_read`, and `has_worker_rls_policy`: RLS and the `ledger_worker_access` policy are active, and `anon`/`authenticated` roles have no read access.
- `has_recovery_attempts_column`: `SELECT` privilege is confirmed on the `recovery_attempts` column.
- `can_call_claim`, `can_call_checkpoint`, `can_call_quarantine`, `can_call_recovery`, and `can_call_find_recoverable`: `EXECUTE` privilege is granted on all five ledger RPC functions.

---

## Security & Retention Notes

- **Least-privilege runtime role:** `order_status_ledger` has `SELECT`, `INSERT`, and `UPDATE` privileges on the ledger table and `EXECUTE` on the five RPC functions—no `DELETE`, `DDL`, role management, or RLS bypass. Do not share this credential with unrelated workflows.
- **Indefinite key retention:** Completed `(mailbox, source_message_id)` rows are retained permanently to prevent duplicate processing if an old email is ever re-polled. There is no automated TTL or purge job.
- **Backups & migrations:** Before migrating databases, back up all ledger columns (`mailbox`, `source_message_id`, `thread_id`, `owner_token`, `execution_id`, `candidate_version`, `phase`, `status`, `outcome`, `intent`, `draft_id`, `draft_message_id`, `last_error`, `recovery_attempts`, `recovery`, and timestamps). Treat backups as private data because `intent` and `recovery` contain email addresses, subjects, and draft reply text.

---

## References

- [Supabase: Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: Managing Postgres Roles](https://supabase.com/docs/guides/database/postgres/roles)
- [PostgreSQL: INSERT ... ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html)
