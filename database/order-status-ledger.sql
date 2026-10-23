-- Run once in the NEW project's Supabase SQL editor as postgres.
-- Deliberately no password here. Set the role password separately, privately.
-- Existing objects cause an error: inspect instead of silently changing a ledger.
begin;

create role order_status_ledger login nosuperuser nocreatedb nocreaterole
  noinherit noreplication nobypassrls;

create table public.order_status_ledger (
  mailbox text not null check (mailbox = lower(btrim(mailbox)) and mailbox <> ''),
  source_message_id text not null check (source_message_id <> ''),
  thread_id text not null check (thread_id <> ''),
  phase text not null default 'Processing'
    check (phase in ('Processing','DraftIntentRecorded','DraftSaved','LabelsPending','Completed')),
  status text not null default 'Running'
    check (status in ('Running','NeedsRecovery','NeedsInspection','Completed')),
  owner_token text not null check (owner_token <> ''),
  execution_id text not null check (execution_id <> ''),
  candidate_version text not null check (candidate_version <> ''),
  outcome text check (outcome in ('draft_ready','manual_review')),
  intent jsonb,
  draft_id text,
  draft_message_id text,
  last_error text,
  recovery jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (mailbox, source_message_id),
  check ((phase = 'Completed') = (status = 'Completed')),
  check (phase not in ('DraftIntentRecorded','DraftSaved') or
    (outcome = 'draft_ready' and intent is not null)),
  check (phase <> 'DraftSaved' or
    (nullif(draft_id,'') is not null and nullif(draft_message_id,'') is not null)),
  check (phase not in ('LabelsPending','Completed') or outcome is not null),
  check (phase not in ('LabelsPending','Completed') or outcome <> 'draft_ready' or
    (intent is not null and nullif(draft_id,'') is not null and nullif(draft_message_id,'') is not null))
);

alter table public.order_status_ledger enable row level security;
revoke all on public.order_status_ledger from public, anon, authenticated;
grant usage on schema public to order_status_ledger;
grant select, insert, update on public.order_status_ledger to order_status_ledger;
create policy ledger_worker_access on public.order_status_ledger
  for all to order_status_ledger using (true) with check (true);

-- Uniqueness arbitrates concurrent first claims. A loser never receives permission
-- to process; the later SELECT is only for reporting, not the exclusion mechanism.
create function public.claim_order_status_request(p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r public.order_status_ledger; won boolean;
begin
  insert into public.order_status_ledger
    (mailbox,source_message_id,thread_id,owner_token,execution_id,candidate_version)
  values (p->>'mailbox',p->>'source_message_id',p->>'thread_id',
    p->>'owner_token',p->>'execution_id',p->>'candidate_version')
  on conflict (mailbox,source_message_id) do nothing returning * into r;
  won := found;
  if not won then
    select * into strict r from public.order_status_ledger
      where mailbox=p->>'mailbox' and source_message_id=p->>'source_message_id';
  end if;
  return jsonb_build_object('acquired',won,'result',case when won then 'Claimed'
    when r.phase='Completed' then 'AlreadyCompleted' else 'OwnershipConflict' end,
    'record',to_jsonb(r));
end $$;

-- Checkpoints are synchronous permission gates. A rejected/unknown response
-- must stop the caller. No checkpoint function creates Gmail side effects.
create function public.checkpoint_order_status_request(p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r public.order_status_ledger; target text := p->>'next_phase';
begin
  select * into strict r from public.order_status_ledger
    where mailbox=p->>'mailbox' and source_message_id=p->>'source_message_id'
    for update;
  if r.owner_token is distinct from p->>'owner_token' or r.status <> 'Running'
    or r.phase is distinct from p->>'expected_phase' then
    raise exception 'LedgerOwnershipOrPhaseConflict';
  end if;
  if p->>'action' = 'failure' then
    update public.order_status_ledger set
      status=case when r.phase='DraftIntentRecorded' or p->>'inspection'='true'
        then 'NeedsInspection' else 'NeedsRecovery' end,
      last_error=left(coalesce(p->>'error','ExecutionFailed'),2000),updated_at=now()
      where mailbox=r.mailbox and source_message_id=r.source_message_id returning * into r;
    return to_jsonb(r);
  end if;
  if not ((r.phase='Processing' and target in ('DraftIntentRecorded','LabelsPending'))
    or (r.phase='DraftIntentRecorded' and target='DraftSaved')
    or (r.phase='DraftSaved' and target='LabelsPending')
    or (r.phase='LabelsPending' and target in ('LabelsPending','Completed'))) then
    raise exception 'IllegalLedgerTransition';
  end if;
  if target='DraftIntentRecorded' and
    (nullif(p->'intent'->>'recipient','') is null or
     p->'intent'->>'thread_id' is distinct from r.thread_id or
     p->'intent'->>'message_id' is distinct from r.source_message_id or
     p->'intent'->>'subject' is null or nullif(p->'intent'->>'reply_body','') is null) then
    raise exception 'IncompleteDraftIntent';
  end if;
  if target='LabelsPending' and not
    ((r.phase='Processing' and p->>'outcome'='manual_review') or
     (r.phase in ('DraftSaved','LabelsPending') and r.outcome='draft_ready' and
      p->>'draft_verified'='true') or
     (r.phase='LabelsPending' and r.outcome='manual_review')) then
    raise exception 'OutcomeNotVerified';
  end if;
  if target='Completed' and p->>'labels_verified' is distinct from 'true' then
    raise exception 'LabelsNotVerified';
  end if;
  update public.order_status_ledger set
    phase=target,status=case when target='Completed' then 'Completed' else 'Running' end,
    outcome=case when target='DraftIntentRecorded' then 'draft_ready'
      when r.phase='Processing' and target='LabelsPending' then 'manual_review' else r.outcome end,
    intent=case when target='DraftIntentRecorded' then p->'intent' else r.intent end,
    draft_id=case when target='DraftSaved' then p->>'draft_id' else r.draft_id end,
    draft_message_id=case when target='DraftSaved' then p->>'draft_message_id' else r.draft_message_id end,
    last_error=null,
    recovery=case when target='Completed' and r.recovery is not null
      then r.recovery || jsonb_build_object('result','Completed','completed_at',now()) else r.recovery end,
    updated_at=now()
    where mailbox=r.mailbox and source_message_id=r.source_message_id returning * into r;
  return to_jsonb(r);
end $$;

-- Caller must first verify the old native execution is stopped, reconcile any
-- outstanding Gmail writes, read the real source, and verify an adopted draft.
-- The database enforces compare-and-swap; it cannot cancel an execution or Gmail.
create function public.recover_order_status_request(p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare r public.order_status_ledger;
begin
  select * into strict r from public.order_status_ledger
    where mailbox=p->>'mailbox' and source_message_id=p->>'source_message_id' for update;
  if r.phase='Completed' then
    return jsonb_build_object('acquired',false,'result','AlreadyCompleted','record',to_jsonb(r));
  end if;
  if r.owner_token is distinct from p->>'expected_owner' or
    r.phase is distinct from p->>'expected_phase' or
    r.status is distinct from p->>'expected_status' or
    r.execution_id is distinct from p->>'old_execution_id' or
    r.candidate_version is distinct from p->>'old_candidate_version' then
    return jsonb_build_object('acquired',false,'result','OwnershipConflict','record',to_jsonb(r));
  end if;
  if p->>'old_execution_stopped' is distinct from 'true' or
    p->>'writes_settled' is distinct from 'true' or nullif(btrim(p->>'note'),'') is null or
    nullif(p->>'owner_token','') is null or p->>'owner_token'=r.owner_token or
    nullif(p->>'execution_id','') is null or nullif(p->>'candidate_version','') is null then
    raise exception 'RecoveryEvidenceRequired';
  end if;
  if r.candidate_version is distinct from p->>'candidate_version' and
    p->>'accept_changed_version' is distinct from 'true' then
    return jsonb_build_object('acquired',false,'result','CandidateVersionMismatch','record',to_jsonb(r));
  end if;
  if r.phase='DraftIntentRecorded' and
    (p->>'draft_verified' is distinct from 'true' or nullif(p->>'draft_id','') is null or
     nullif(p->>'draft_message_id','') is null) then
    return jsonb_build_object('acquired',false,'result','UncertainWriteNeedsInspection','record',to_jsonb(r));
  end if;
  update public.order_status_ledger set
    owner_token=p->>'owner_token',execution_id=p->>'execution_id',
    candidate_version=p->>'candidate_version',status='Running',
    phase=case when r.phase='DraftIntentRecorded' then 'DraftSaved' else r.phase end,
    draft_id=case when r.phase='DraftIntentRecorded' then p->>'draft_id' else r.draft_id end,
    draft_message_id=case when r.phase='DraftIntentRecorded' then p->>'draft_message_id' else r.draft_message_id end,
    recovery=jsonb_build_object('previous_owner',r.owner_token,'previous_execution',r.execution_id,
      'previous_candidate',r.candidate_version,'previous_phase',r.phase,'note',p->>'note',
      'inspected_draft_id',p->>'draft_id','started_at',now(),'result','Running'),updated_at=now()
    where mailbox=r.mailbox and source_message_id=r.source_message_id returning * into r;
  return jsonb_build_object('acquired',true,'result','RecoveryClaimed','record',to_jsonb(r));
end $$;

revoke all on function public.claim_order_status_request(jsonb) from public, anon, authenticated;
revoke all on function public.checkpoint_order_status_request(jsonb) from public, anon, authenticated;
revoke all on function public.recover_order_status_request(jsonb) from public, anon, authenticated;
grant execute on function public.claim_order_status_request(jsonb) to order_status_ledger;
grant execute on function public.checkpoint_order_status_request(jsonb) to order_status_ledger;
grant execute on function public.recover_order_status_request(jsonb) to order_status_ledger;

commit;
