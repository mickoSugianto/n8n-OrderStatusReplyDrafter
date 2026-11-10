-- Run once in an existing project's Supabase SQL editor as postgres.
-- Idempotent upgrade from manual recovery to bounded automated recovery.
begin;

alter table public.order_status_ledger
  add column if not exists recovery_attempts integer not null default 0
  check (recovery_attempts >= 0);

create or replace function public.checkpoint_order_status_request(p jsonb) returns jsonb
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
      status=case when p->>'inspection'='true' or r.recovery_attempts >= 1
        then 'NeedsInspection' else 'NeedsRecovery' end,
      last_error=left(coalesce(nullif(btrim(p->>'error'),''),'ExecutionFailed'),2000),updated_at=now()
      where mailbox=r.mailbox and source_message_id=r.source_message_id returning * into r;
    return to_jsonb(r);
  end if;
  if not ((r.phase='Processing' and target in ('DraftIntentRecorded','LabelsPending'))
    or (r.phase='DraftIntentRecorded' and target in ('DraftIntentRecorded','DraftSaved'))
    or (r.phase='DraftSaved' and target='LabelsPending')
    or (r.phase='LabelsPending' and target in ('LabelsPending','Completed'))) then
    raise exception 'IllegalLedgerTransition';
  end if;
  if r.phase='DraftIntentRecorded' and target='DraftIntentRecorded' and
    r.intent is distinct from p->'intent' then
    raise exception 'DraftIntentImmutableConflict';
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

create or replace function public.quarantine_order_status_request(p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  r public.order_status_ledger;
  err text := left(coalesce(nullif(btrim(p->>'error'),''),'NeedsInspection'),2000);
begin
  select * into strict r from public.order_status_ledger
    where mailbox=p->>'mailbox' and source_message_id=p->>'source_message_id' for update;
  if r.phase='Completed' then
    return jsonb_build_object('quarantined',false,'result','AlreadyCompleted','record',to_jsonb(r));
  end if;
  if r.status='NeedsInspection' then
    return jsonb_build_object('quarantined',false,'result','AlreadyQuarantined','record',to_jsonb(r));
  end if;
  if r.owner_token is distinct from p->>'expected_owner' or
    (nullif(p->>'expected_phase','') is not null and r.phase is distinct from p->>'expected_phase') then
    return jsonb_build_object('quarantined',false,'result','OwnershipConflict','record',to_jsonb(r));
  end if;
  update public.order_status_ledger set
    status='NeedsInspection',
    last_error=err,
    recovery=coalesce(r.recovery,'{}'::jsonb) || jsonb_build_object(
      'last_quarantine',jsonb_build_object('error',err,'execution_id',p->>'execution_id','at',now()),
      'history',coalesce(r.recovery->'history','[]'::jsonb) || jsonb_build_array(
        jsonb_build_object('action','quarantine','owner_token',r.owner_token,'phase',r.phase,
          'error',err,'execution_id',p->>'execution_id','at',now()))),
    updated_at=now()
    where mailbox=r.mailbox and source_message_id=r.source_message_id returning * into r;
  return jsonb_build_object('quarantined',true,'result','Quarantined','record',to_jsonb(r));
end $$;

create or replace function public.recover_order_status_request(p jsonb) returns jsonb
language plpgsql security invoker set search_path = '' as $$
declare
  r public.order_status_ledger;
  adopt_draft boolean;
  recreate_intent boolean;
  rec_mode text := coalesce(nullif(btrim(p->>'mode'),''),'manual');
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
  if rec_mode='auto' and r.recovery_attempts >= 1 then
    return jsonb_build_object('acquired',false,'result','MaxAttemptsReached','record',to_jsonb(r));
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
  adopt_draft := p->>'draft_verified'='true' and p->>'draft_absent_verified' is distinct from 'true'
    and nullif(p->>'draft_id','') is not null and nullif(p->>'draft_message_id','') is not null;
  recreate_intent := p->>'draft_absent_verified'='true' and p->>'draft_verified' is distinct from 'true'
    and r.intent is not null;
  if r.phase='DraftIntentRecorded' and
    not (adopt_draft or recreate_intent) then
    return jsonb_build_object('acquired',false,'result','UncertainWriteNeedsInspection','record',to_jsonb(r));
  end if;
  update public.order_status_ledger set
    owner_token=p->>'owner_token',execution_id=p->>'execution_id',
    candidate_version=p->>'candidate_version',status='Running',
    recovery_attempts=r.recovery_attempts + 1,
    phase=case when r.phase='DraftIntentRecorded' and adopt_draft then 'DraftSaved' else r.phase end,
    draft_id=case when r.phase='DraftIntentRecorded' and adopt_draft then p->>'draft_id' else r.draft_id end,
    draft_message_id=case when r.phase='DraftIntentRecorded' and adopt_draft then p->>'draft_message_id' else r.draft_message_id end,
    recovery=coalesce(r.recovery,'{}'::jsonb) || jsonb_build_object(
      'previous_owner',r.owner_token,'previous_execution',r.execution_id,
      'previous_candidate',r.candidate_version,'previous_phase',r.phase,
      'mode',rec_mode,'attempt',r.recovery_attempts + 1,'note',p->>'note',
      'inspected_draft_id',nullif(p->>'draft_id',''),
      'draft_absent_verified',recreate_intent,'started_at',now(),'result','Running',
      'history',coalesce(r.recovery->'history','[]'::jsonb) || jsonb_build_array(
        jsonb_build_object('action','recover','attempt',r.recovery_attempts + 1,'mode',rec_mode,
          'previous_owner',r.owner_token,'previous_execution',r.execution_id,
          'previous_candidate',r.candidate_version,'previous_phase',r.phase,
          'new_owner',p->>'owner_token','new_execution',p->>'execution_id','note',p->>'note',
          'inspected_draft_id',nullif(p->>'draft_id',''),
          'draft_absent_verified',recreate_intent,'started_at',now()))),
    updated_at=now()
    where mailbox=r.mailbox and source_message_id=r.source_message_id returning * into r;
  return jsonb_build_object('acquired',true,'result','RecoveryClaimed','record',to_jsonb(r));
end $$;

create or replace function public.find_recoverable_order_status_requests(p jsonb) returns jsonb
language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(s)), '[]'::jsonb)
  from (
    select *
    from public.order_status_ledger
    where mailbox = lower(btrim(p->>'mailbox'))
      and phase <> 'Completed'
      and status in ('NeedsRecovery', 'Running')
      and (status = 'Running' or recovery_attempts < 1)
      and updated_at <= now() - make_interval(secs => greatest(coalesce((p->>'cooldown_seconds')::int, 300), 90))
    order by updated_at asc
    limit greatest(least(coalesce((p->>'limit')::int, 5), 25), 1)
  ) s;
$$;

revoke all on function public.claim_order_status_request(jsonb) from public, anon, authenticated;
revoke all on function public.checkpoint_order_status_request(jsonb) from public, anon, authenticated;
revoke all on function public.quarantine_order_status_request(jsonb) from public, anon, authenticated;
revoke all on function public.recover_order_status_request(jsonb) from public, anon, authenticated;
revoke all on function public.find_recoverable_order_status_requests(jsonb) from public, anon, authenticated;
grant execute on function public.claim_order_status_request(jsonb) to order_status_ledger;
grant execute on function public.checkpoint_order_status_request(jsonb) to order_status_ledger;
grant execute on function public.quarantine_order_status_request(jsonb) to order_status_ledger;
grant execute on function public.recover_order_status_request(jsonb) to order_status_ledger;
grant execute on function public.find_recoverable_order_status_requests(jsonb) to order_status_ledger;

commit;
