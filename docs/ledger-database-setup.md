# Ledger Database Setup

This guide explains how to provision the PostgreSQL idempotency and recovery ledger in Supabase and connect it to n8n.

The setup script [`database/order-status-ledger.sql`](../database/order-status-ledger.sql) is a standalone transactional script. It creates a single table (`public.order_status_ledger`), enables Row-Level Security (RLS), creates a least-privilege login role (`order_status_ledger`), and defines three `SECURITY INVOKER` functions for claiming, checkpointing, and recovering requests.

---

## Prerequisites & Project Settings

1. Create a **dedicated Supabase project** for this ledger.
2. In Supabase Project Settings:
   - Keep **Data API** and **automatic table exposure** **OFF** (the workflow connects over direct/pooled Postgres TLS, not PostgREST).
   - **Automatic RLS** may remain **ON** (the setup script explicitly enables RLS and defines the policy for `order_status_ledger`).

---

## Step-by-Step Setup

### 1. Run the Ledger Setup SQL
1. Open the Supabase **SQL Editor** (runs as the administrative `postgres` user).
2. Paste and execute [`database/order-status-ledger.sql`](../database/order-status-ledger.sql).
   - The script executes inside a single transaction (`BEGIN ... COMMIT`).
   - It is **create-only** and intentionally aborts if `order_status_ledger` or any of the three functions already exist. Never drop an existing ledger table to re-run the script, as deleting completed keys makes previously processed emails eligible again.

### 2. Set a Password for the Runtime Role
1. Generate a strong password privately.
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

### 4. Run the Read-Only Preflight Check
Bind the `OrderStatusLedger` credential to a Postgres node in n8n and execute [`database/verify-order-status-ledger.sql`](../database/verify-order-status-ledger.sql).

This read-only query confirms:
- The active session user is `order_status_ledger` (without superuser, role creation, or `BYPASSRLS` privileges).
- `SELECT`, `INSERT`, and `UPDATE` are granted on `public.order_status_ledger`, while `DELETE` and `TRUNCATE` are denied.
- RLS is enabled on the table and `EXECUTE` permission is present on all three ledger RPC functions.

---

## Security & Retention Notes

- **Least-privilege runtime role:** `order_status_ledger` has `SELECT`, `INSERT`, and `UPDATE` privileges on the ledger table and `EXECUTE` on the three RPC functions—no `DELETE`, `DDL`, role management, or RLS bypass. Do not share this credential with unrelated workflows.
- **Indefinite key retention:** Completed `(mailbox, source_message_id)` rows are retained permanently to prevent duplicate processing if an old email is ever re-polled. There is no automated TTL or purge job.
- **Backups & migrations:** Before migrating databases, back up all ledger columns (`mailbox`, `source_message_id`, `thread_id`, `owner_token`, `execution_id`, `candidate_version`, `phase`, `status`, `outcome`, `intent`, `draft_id`, `draft_message_id`, `last_error`, `recovery`, and timestamps). Treat backups as private data because `intent` and `recovery` contain email addresses, subjects, and draft reply text.

---

## References

- [Supabase: Connecting to Postgres](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase: Managing Postgres Roles](https://supabase.com/docs/guides/database/postgres/roles)
- [PostgreSQL: INSERT ... ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html)
