-- Run using the dedicated worker connection. Read-only installation preflight.
-- This does NOT establish concurrency exclusion or test Gmail behavior.
select
  current_user as database_role,
  current_database() as database_name,
  current_user = 'order_status_ledger' as dedicated_role,
  (select not rolsuper and not rolcreatedb and not rolcreaterole and not rolbypassrls
    from pg_roles where rolname=current_user) as restricted_role,
  has_schema_privilege(current_user,'public','USAGE') as schema_usage,
  not has_schema_privilege(current_user,'public','CREATE') as no_schema_create,
  has_table_privilege(current_user,'public.order_status_ledger','SELECT') as can_read_ledger,
  has_table_privilege(current_user,'public.order_status_ledger','INSERT') as can_claim,
  has_table_privilege(current_user,'public.order_status_ledger','UPDATE') as can_checkpoint,
  not has_table_privilege(current_user,'public.order_status_ledger','DELETE') as no_delete,
  (select relrowsecurity from pg_class where oid='public.order_status_ledger'::regclass) as rls_enabled,
  not has_table_privilege('anon','public.order_status_ledger','SELECT') as no_anonymous_read,
  not has_table_privilege('authenticated','public.order_status_ledger','SELECT') as no_client_read,
  has_function_privilege(current_user,'public.claim_order_status_request(jsonb)','EXECUTE') as can_call_claim,
  has_function_privilege(current_user,'public.checkpoint_order_status_request(jsonb)','EXECUTE') as can_call_checkpoint,
  has_function_privilege(current_user,'public.recover_order_status_request(jsonb)','EXECUTE') as can_call_recovery;

select polname, polcmd, polroles::regrole[], polqual is not null as has_using,
  polwithcheck is not null as has_with_check
from pg_policy where polrelid='public.order_status_ledger'::regclass;
