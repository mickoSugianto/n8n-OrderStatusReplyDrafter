// Portable recovery assertions against the included sanitized snapshot. No network or database writes.
'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const r=require('../src/recovery-policy');
const path=require('node:path');
process.chdir(path.resolve(__dirname,'..'));
const w=JSON.parse(fs.readFileSync('workflows/main-workflow.json'));
const before={id:'<MAIN_WORKFLOW_ID>'};
const contract={candidate:'synthetic-candidate'};
const n=name=>{const v=w.nodes.find(n=>n.name===name);assert(v,name);return v;};
const evaluate=(expression,values)=>Function('$','$execution','return ('+expression.slice(3,-2).trim()+');')(name=>{assert(Object.hasOwn(values,name),'Unexecuted branch referenced: '+name);return {item:{json:values[name]}};},{id:'local-execution'});
let total=0;
function test(name,fn){try{fn();total++;}catch(e){console.error(name);throw e;}}
const source={message_id:'abc',thread_id:'def',subject:'Order status',recipient:'controlled-sender@example.com',reply_body:'Please share your order number.',route:'save'};
const saved={id:'draft-1',message:{id:'draft-message-1',threadId:'def'}};
const draft={id:'draft-1',messageId:'draft-message-1',threadId:'def',subject:source.subject,text:source.reply_body,to:{value:[{address:source.recipient}]},labelIds:['DRAFT']};
const record={mailbox:'controlled-receiver@example.com',source_message_id:'abc',thread_id:'def',owner_token:'old',execution_id:'old',candidate_version:contract.candidate,phase:'Processing',status:'Running',recovery_attempts:0,updated_at:'2026-10-19T00:00:00Z'};
const request={sourceMessageId:'abc',expectedOwnerToken:'old',writesSettled:true,note:'Inspected prior execution and Gmail writes.'};
const autoRequest={mode:'auto',sourceMessageId:'abc',expectedOwnerToken:'old'};
const message={id:'abc',threadId:'def',labelIds:['<INPUT_LABEL_ID>']};
test('stopped, inspected pre-write request may recover',()=>assert.equal(r.recoveryDecision(record,request,message,contract.candidate).proceed,true));
for(const [name,rr,req,src,want]of [
 ['missing',null,request,message,'LedgerRecordNotFound'],
 ['complete',{...record,phase:'Completed',status:'Completed'},request,message,'AlreadyCompleted'],
 ['other owner',record,{...request,expectedOwnerToken:'other'},message,'OwnershipConflict'],
 ['not reconciled',record,{...request,writesSettled:false},message,'OperatorInspectionRequired'],
 ['blank evidence',record,{...request,note:' '},message,'OperatorInspectionRequired'],
 ['version change',{...record,candidate_version:'older'},request,message,'CandidateVersionMismatch'],
 ['source mismatch',record,request,{...message,id:'other'},'SourceMismatchNeedsInspection'],
 ['thread mismatch',record,request,{...message,threadId:'other'},'SourceMismatchNeedsInspection'],
 ['uncertain',{...record,phase:'DraftIntentRecorded'},request,message,'UncertainWriteNeedsInspection']
])test('recovery blocks '+name,()=>{const actual=r.recoveryDecision(rr,req,src,contract.candidate);assert.equal(actual.result,want);assert.equal(actual.proceed,false);});
test('reviewed changed candidate needs explicit boolean',()=>{assert.equal(r.recoveryDecision({...record,candidate_version:'old'},{...request,acceptChangedVersion:'true'},message,contract.candidate).proceed,false);assert.equal(r.recoveryDecision({...record,candidate_version:'old'},{...request,acceptChangedVersion:true},message,contract.candidate).proceed,true);});
test('source read failure quarantines in both modes',()=>{
 const errAuto=r.recoveryDecision(record,autoRequest,{error:'404 Not Found'},contract.candidate);
 assert.equal(errAuto.result,'SourceReadFailedNeedsInspection');
 assert.equal(errAuto.proceed,false);
 assert.equal(errAuto.quarantine,true);
 assert.equal(errAuto.error,'404 Not Found');
});
test('version mismatch quarantines in auto mode but not manual mode',()=>{
 const manVer=r.recoveryDecision({...record,candidate_version:'older'},request,message,contract.candidate);
 assert.equal(manVer.result,'CandidateVersionMismatch');
 assert.equal(manVer.quarantine,false);
 const autoVer=r.recoveryDecision({...record,candidate_version:'older'},autoRequest,message,contract.candidate);
 assert.equal(autoVer.result,'CandidateVersionMismatch');
 assert.equal(autoVer.quarantine,true);
 assert.equal(autoVer.error,'CandidateVersionMismatch');
});
test('auto mode allows DraftIntentRecorded without inspectedDraftId to proceed to thread reconciler',()=>{
 const autoIntent=r.recoveryDecision({...record,phase:'DraftIntentRecorded',status:'NeedsRecovery'},autoRequest,message,contract.candidate);
 assert.equal(autoIntent.result,'Ready');
 assert.equal(autoIntent.proceed,true);
 assert.equal(autoIntent.quarantine,false);
});
test('auto mode enforces attempt cap on NeedsRecovery but lets Running check execution liveness first',()=>{
 const alreadyQ=r.recoveryDecision({...record,status:'NeedsInspection'},autoRequest,message,contract.candidate);
 assert.equal(alreadyQ.result,'AlreadyQuarantined');
 assert.equal(alreadyQ.proceed,false);
 assert.equal(alreadyQ.quarantine,false);
 const capped=r.recoveryDecision({...record,status:'NeedsRecovery',recovery_attempts:1},autoRequest,message,contract.candidate);
 assert.equal(capped.result,'MaxAttemptsReached');
 assert.equal(capped.proceed,false);
 assert.equal(capped.quarantine,true);
 const staleRunning=r.recoveryDecision({...record,status:'Running',recovery_attempts:1},autoRequest,message,contract.candidate);
 assert.equal(staleRunning.result,'Ready');
 assert.equal(staleRunning.proceed,true);
});
const evidence={record,request};
const autoEvidence={record,request:autoRequest};
const baseNowMs=Date.parse('2026-10-19T00:05:00Z');
for(const status of ['running','new','waiting','unknown'])test('reject healthy active previous execution '+status,()=>{const actual=r.stoppedExecution(evidence,{id:'old',workflowId:before.id,status,startedAt:'2026-10-19T00:00:00Z'},before.id,baseNowMs);assert.equal(actual.oldExecutionStopped,false);assert.equal(actual.result,'OwnershipConflict');assert.equal(actual.quarantine,false);});
for(const [change,want] of [
 [{id:'other'},'PreviousExecutionMissingOrMismatchNeedsInspection'],
 [{workflowId:'other'},'PreviousExecutionMissingOrMismatchNeedsInspection'],
 [{error:'404 Not Found'},'PreviousExecutionMissingOrMismatchNeedsInspection'],
 [{stoppedAt:null},'PreviousExecutionOrOutstandingWritesNotReconciled']
])test('quarantine wrong or missing stopped execution '+JSON.stringify(change),()=>{const actual=r.stoppedExecution(evidence,{id:'old',workflowId:before.id,status:'error',stoppedAt:'2026-10-19T00:00:00Z',...change},before.id,baseNowMs);assert.equal(actual.oldExecutionStopped,false);assert.equal(actual.quarantine,true);assert.equal(actual.result,want);});
test('active execution >= 10m quarantines as zombie timeout',()=>{
 const zombieNowMs=Date.parse('2026-10-19T00:10:00Z');
 const actual=r.stoppedExecution(autoEvidence,{id:'old',workflowId:before.id,status:'running',startedAt:'2026-10-19T00:00:00Z'},before.id,zombieNowMs);
 assert.equal(actual.oldExecutionStopped,false);
 assert.equal(actual.quarantine,true);
 assert.equal(actual.result,'PreviousExecutionTimedOutNeedsInspection');
});
test('crashed auto-retry with recovery_attempts >= 1 quarantines after terminal check',()=>{
 const crashedRetry=r.stoppedExecution({record:{...record,recovery_attempts:1},request:autoRequest},{id:'old',workflowId:before.id,status:'crashed',stoppedAt:'2026-10-19T00:01:00Z'},before.id,baseNowMs);
 assert.equal(crashedRetry.oldExecutionStopped,true);
 assert.equal(crashedRetry.quarantine,true);
 assert.equal(crashedRetry.result,'MaxAutoRecoveryAttemptsExhaustedAfterCrash');
});
test('auto mode enforces 60s write-settle window and populates audit note after settle',()=>{
 const pending=r.stoppedExecution(autoEvidence,{id:'old',workflowId:before.id,status:'error',stoppedAt:'2026-10-19T00:04:15Z'},before.id,baseNowMs);
 assert.equal(pending.oldExecutionStopped,false);
 assert.equal(pending.quarantine,false);
 assert.equal(pending.result,'WriteSettlePending');
 const settled=r.stoppedExecution(autoEvidence,{id:'old',workflowId:before.id,status:'error',stoppedAt:'2026-10-19T00:04:00Z'},before.id,baseNowMs);
 assert.equal(settled.oldExecutionStopped,true);
 assert.equal(settled.quarantine,false);
 assert.equal(settled.result,'Ready');
 assert.equal(settled.request.writesSettled,true);
 assert(settled.request.note.includes('Auto-recovery verified stopped execution old'));
});
test('native failed execution is stopped even with finished false',()=>assert.equal(r.stoppedExecution(evidence,{id:'old',workflowId:before.id,status:'error',finished:false,stoppedAt:'2026-10-19T00:00:00Z'},before.id,baseNowMs).oldExecutionStopped,true));
for(const status of ['success','error','canceled','crashed'])test('accept reconciled terminal execution '+status,()=>assert.equal(r.stoppedExecution(evidence,{id:'old',workflowId:before.id,status,stoppedAt:'2026-10-19T00:00:00Z'},before.id,baseNowMs).oldExecutionStopped,true));
test('reconcileThreadAndDrafts handles multi-turn earlier SENT message with 0 drafts',()=>{
 const res=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'earlier-1',labelIds:['SENT']},{id:'abc',labelIds:['INBOX']}]},[{id:'other-draft',message:{id:'other-msg',threadId:'other-thread'}}]);
 assert.equal(res.quarantine,false);
 assert.equal(res.resolution,'AbsentCreateFromIntent');
 assert.equal(res.draftAbsentVerified,true);
});
test('reconcileThreadAndDrafts quarantines SENT or customer follow-up message after source',()=>{
 const sentAfter=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'abc',labelIds:['INBOX']},{id:'reply-1',labelIds:['SENT']}]},[]);
 assert.equal(sentAfter.quarantine,true);
 assert.equal(sentAfter.result,'SentOrNewerMessageAfterSourceNeedsInspection');
 const followUp=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'abc',labelIds:['INBOX']},{id:'followup-1',labelIds:['INBOX']}]},[]);
 assert.equal(followUp.quarantine,true);
 assert.equal(followUp.result,'SentOrNewerMessageAfterSourceNeedsInspection');
});
test('reconcileThreadAndDrafts adopts 1 matching draft across thread and draftList',()=>{
 const single=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'abc',labelIds:['INBOX']},{id:'draft-message-1',labelIds:['DRAFT']}]},[{id:'draft-1',message:{id:'draft-message-1',threadId:'def'}}]);
 assert.equal(single.quarantine,false);
 assert.equal(single.resolution,'InspectSingleDraft');
 assert.equal(single.inspectedDraftId,'draft-1');
 assert.equal(single.draftMessageId,'draft-message-1');
});
test('reconcileThreadAndDrafts quarantines inconsistency, multiple drafts, missing source, or API errors',()=>{
 const inconsistentCount=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'abc',labelIds:['INBOX']}]},[{id:'draft-1',message:{id:'draft-message-1',threadId:'def'}}]);
 assert.equal(inconsistentCount.quarantine,true);
 assert.equal(inconsistentCount.result,'DraftThreadListInconsistentNeedsInspection');
 const inconsistentId=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'abc',labelIds:['INBOX']},{id:'draft-message-2',labelIds:['DRAFT']}]},[{id:'draft-1',message:{id:'draft-message-1',threadId:'def'}}]);
 assert.equal(inconsistentId.quarantine,true);
 assert.equal(inconsistentId.result,'DraftThreadListInconsistentNeedsInspection');
 const multi=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'abc',labelIds:['INBOX']},{id:'dm-1',labelIds:['DRAFT']},{id:'dm-2',labelIds:['DRAFT']}]},[{id:'d-1',message:{id:'dm-1',threadId:'def'}},{id:'d-2',message:{id:'dm-2',threadId:'def'}}]);
 assert.equal(multi.quarantine,true);
 assert.equal(multi.result,'MultipleDraftsInThreadNeedsInspection');
 const missingSource=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'other-msg',labelIds:['INBOX']}]},[]);
 assert.equal(missingSource.quarantine,true);
 assert.equal(missingSource.result,'SourceMessageMissingFromThreadNeedsInspection');
 const apiErr=r.reconcileThreadAndDrafts(record,{error:'Gmail 503'},[]);
 assert.equal(apiErr.quarantine,true);
 assert.equal(apiErr.result,'GmailThreadOrDraftReadFailedNeedsInspection');
 const draftErr=r.reconcileThreadAndDrafts(record,{id:'def',messages:[{id:'abc',labelIds:['INBOX']}]},[{error:'Gmail 500'}]);
 assert.equal(draftErr.quarantine,true);
 assert.equal(draftErr.result,'GmailThreadOrDraftReadFailedNeedsInspection');
});
const workflowConfig={customerEmail:'controlled-sender@example.com',receiverEmail:'controlled-receiver@example.com',inputLabelId:'<INPUT_LABEL_ID>',triagedLabelId:'<TRIAGED_LABEL_ID>',reviewLabelId:'<REVIEW_LABEL_ID>'};
test('saved draft passes shared actual confirmation expression',()=>assert.equal(evaluate(n('ConfirmSavedDraft').parameters.jsonOutput,{WorkflowConfig:workflowConfig,DraftToConfirm:{source,saved},ReadSavedDraft:draft}).draft_confirmed,true));
for(const change of [{id:'different'},{messageId:'different'},{threadId:'different'},{subject:'Human edit'},{text:'Human edit'},{to:{value:[{address:'other@example.com'}]}},{to:{value:[{address:source.recipient},{address:'other@example.com'}]}},{cc:{value:[{address:'other@example.com'}]}},{bcc:{value:[{address:'other@example.com'}]}},{labelIds:['SENT']}])test('reject draft change '+JSON.stringify(change),()=>assert.throws(()=>evaluate(n('ConfirmSavedDraft').parameters.jsonOutput,{WorkflowConfig:workflowConfig,DraftToConfirm:{source,saved},ReadSavedDraft:{...draft,...change}})));
test('recovered draft must satisfy current recipient guard',()=>{const changed={...source,recipient:'revoked@example.com'};assert.throws(()=>evaluate(n('ConfirmSavedDraft').parameters.jsonOutput,{WorkflowConfig:workflowConfig,DraftToConfirm:{source:changed,saved},ReadSavedDraft:{...draft,to:{value:[{address:changed.recipient}]}}}));});
test('review requires both labels',()=>{assert.throws(()=>r.verifiedLabels({id:'abc',threadId:'def',labelIds:['triaged']},source,['review','triaged']));assert.equal(r.verifiedLabels({id:'abc',threadId:'def',labelIds:['review','triaged']},source,['review','triaged']).labels_verified,true);});
test('simplified native Gmail label objects are verified',()=>{assert.equal(r.verifiedLabels({id:'abc',threadId:'def',labels:[{id:'review'},{id:'triaged'}]},source,['review','triaged']).labels_verified,true);assert.throws(()=>r.verifiedLabels({id:'abc',threadId:'def',labels:[{id:'triaged'}]},source,['review','triaged']));});
for(const change of [{id:'other'},{threadId:'other'},{labelIds:[]}])test('reject label evidence '+JSON.stringify(change),()=>assert.throws(()=>r.verifiedLabels({id:'abc',threadId:'def',labelIds:['triaged'],...change},source,['triaged'])));
test('authenticated mailbox namespace verified before claim',()=>{const values={WorkflowConfig:workflowConfig,ReadMailboxIdentity:{emailAddress:record.mailbox},AuthorizedSourceRequest:{message,mode:'intake'}};assert.equal(evaluate(n('VerifyMailboxAndSource').parameters.jsonOutput,values).mailbox,record.mailbox);assert.throws(()=>evaluate(n('VerifyMailboxAndSource').parameters.jsonOutput,{...values,ReadMailboxIdentity:{emailAddress:'other@example.com'}}));});
test('recovery cannot substitute a source body or ID',()=>assert.throws(()=>evaluate(n('VerifyMailboxAndSource').parameters.jsonOutput,{WorkflowConfig:workflowConfig,ReadMailboxIdentity:{emailAddress:record.mailbox},AuthorizedSourceRequest:{message,mode:'recovery',request:{sourceMessageId:'different'}}})));
test('recovery allows source API read error only with valid hex sourceMessageId',()=>{
 const ok=evaluate(n('VerifyMailboxAndSource').parameters.jsonOutput,{WorkflowConfig:workflowConfig,ReadMailboxIdentity:{emailAddress:record.mailbox},AuthorizedSourceRequest:{message:{error:'404 Not Found'},mode:'recovery',request:{sourceMessageId:'abc'}}});
 assert.equal(ok.sourceMessageId,'abc');
 assert.throws(()=>evaluate(n('VerifyMailboxAndSource').parameters.jsonOutput,{WorkflowConfig:workflowConfig,ReadMailboxIdentity:{emailAddress:record.mailbox},AuthorizedSourceRequest:{message:{error:'404 Not Found'},mode:'recovery',request:{sourceMessageId:'not-hex!'}}}));
 assert.throws(()=>evaluate(n('VerifyMailboxAndSource').parameters.jsonOutput,{WorkflowConfig:workflowConfig,ReadMailboxIdentity:{emailAddress:record.mailbox},AuthorizedSourceRequest:{message:{error:'404 Not Found'},mode:'intake'}}));
});
test('shared recovery helpers match the included main expressions',()=>{const expressions=w.nodes.map(n=>n.parameters.jsonOutput||'').join('\n');for(const [name,fn] of Object.entries(r))assert(expressions.includes(fn.toString()),name+' differs from main snapshot');});
const edges=name=>(w.connections[name]?.main||[]).map(targets=>(targets||[]).map(t=>t.node));
test('losing claim has no business/Gmail write successor',()=>{assert.deepEqual(edges('OwnerAcquired')[1],['ReturnSkippedRequest']);assert(!w.connections.ReturnSkippedRequest);});
test('recovery rejection has no downstream writes and quarantine routes to PrepareQuarantineRequest',()=>{
 assert.deepEqual(edges('RecoveryMayProceed')[0],['ReadPreviousExecution']);
 assert.deepEqual(edges('RecoveryMayProceed')[1],['ReturnRecoveryDecision']);
 assert.deepEqual(edges('RecoveryMayProceed')[2],['PrepareQuarantineRequest']);
 assert(!w.connections.ReturnRecoveryDecision);
});
test('Phase 00 external reads, thread reconciler, and quarantine topology',()=>{
 assert.equal(n('ReadRecoverySource').onError,'continueErrorOutput');
 assert.deepEqual(edges('ReadRecoverySource'),[['PrepareRecoveryEnvelope'],['PrepareRecoveryEnvelope']]);
 assert.equal(n('ReadPreviousExecution').onError,'continueErrorOutput');
 assert.deepEqual(edges('ReadPreviousExecution'),[['VerifyPreviousExecutionStopped'],['VerifyPreviousExecutionStopped']]);
 assert.deepEqual(edges('InspectedDraftRequired'),[
  ['PrepareQuarantineRequest'],
  ['ReadRecoveryThread'],
  ['ReadInspectedDraft'],
  ['RecoveryEvidence'],
  ['ReturnOwnershipConflict']
 ]);
 assert.equal(n('ReadRecoveryThread').onError,'continueErrorOutput');
 assert.deepEqual(edges('ReadRecoveryThread'),[['ListMailboxDrafts'],['ListMailboxDrafts']]);
 assert.equal(n('ListMailboxDrafts').onError,'continueErrorOutput');
 assert.equal(n('ListMailboxDrafts').alwaysOutputData,true);
 assert.deepEqual(edges('ListMailboxDrafts'),[['ReconcileUncertainDraft'],['ReconcileUncertainDraft']]);
 assert.equal(n('ReconcileUncertainDraft').executeOnce,true);
 assert.deepEqual(edges('ReconcileUncertainDraft'),[['RouteDraftReconciliation']]);
 assert.deepEqual(edges('RouteDraftReconciliation'),[
  ['ReadInspectedDraft'],
  ['RecoveryEvidence'],
  ['PrepareQuarantineRequest']
 ]);
 assert.equal(n('ReadInspectedDraft').onError,'continueErrorOutput');
 assert.deepEqual(edges('ReadInspectedDraft'),[['VerifyInspectedDraft'],['PrepareQuarantineRequest']]);
 assert.equal(n('VerifyInspectedDraft').onError,'continueErrorOutput');
 assert.deepEqual(edges('VerifyInspectedDraft'),[['RecoveryEvidence'],['PrepareQuarantineRequest']]);
 assert.deepEqual(edges('PrepareQuarantineRequest'),[['QuarantineRecoveryRequest']]);
 assert.deepEqual(edges('QuarantineRecoveryRequest'),[['QuarantineApplied']]);
 assert.deepEqual(edges('QuarantineApplied'),[['StopVisiblyWithoutTriage'],['ReturnQuarantineSkipped']]);
 assert(!w.connections.ReturnQuarantineSkipped);
});
test('write intent before create; ID before readback',()=>{assert.deepEqual(edges('SaveRecipientAccepted')[0],['RecordDraftIntent']);assert.deepEqual(edges('RecordDraftIntent')[0],['SaveReviewDraft']);assert.deepEqual(edges('SaveReviewDraft')[0],['RecordSavedDraft']);assert.deepEqual(edges('RecordSavedDraft')[0],['PrepareSavedDraftContext']);assert.deepEqual(edges('DraftToConfirm')[0],['ReadSavedDraft']);assert.equal(n('SaveReviewDraft').retryOnFail,false);});
test('saved-draft recovery cannot reach a creator/model',()=>{const seen=new Set(),queue=['RestoreRecordedDraft'];while(queue.length){const name=queue.shift();if(seen.has(name))continue;seen.add(name);for(const targets of edges(name))queue.push(...targets);}for(const name of ['SaveReviewDraft','ExtractRequestGroq','ExtractRequestOpenRouter','GetOrderDeterministically','WriteVerifiedReplyGroq','WriteVerifiedReplyOpenRouter'])assert(!seen.has(name),name);assert(seen.has('ReadSavedDraft'));assert(seen.has('CompleteLedger'));});
test('draft-intent recovery bypasses LLM and Sheets and resumes at SharedReplyContext',()=>{
 assert.deepEqual(edges('ResumeRecordedPhase')[3],['RestoreRecordedIntent']);
 assert.deepEqual(edges('RestoreRecordedIntent'),[['SharedReplyContext']]);
 const seen=new Set(),queue=['RestoreRecordedIntent'];
 while(queue.length){const name=queue.shift();if(seen.has(name))continue;seen.add(name);for(const targets of edges(name))queue.push(...targets);}
 for(const name of ['ExtractRequestGroq','ExtractRequestOpenRouter','GetOrderDeterministically','WriteVerifiedReplyGroq','WriteVerifiedReplyOpenRouter'])assert(!seen.has(name),name);
 assert(seen.has('RecordDraftIntent'));
 assert(seen.has('SaveReviewDraft'));
 assert(seen.has('CompleteLedger'));
 const intentParams=evaluate(n('RecordDraftIntent').parameters.options.queryReplacement,{OwnedRequest:{ledger:{...record,phase:'DraftIntentRecorded'}},RecheckAllowedRecipient:source});
 assert.equal(JSON.parse(intentParams[0]).expected_phase,'DraftIntentRecorded');
});
test('Phase 08 alert gate suppresses NeedsRecovery and alerts NeedsInspection',()=>{
 assert.equal(n('RecordUnfinishedWork').onError,'continueErrorOutput');
 assert.deepEqual(edges('RecordUnfinishedWork'),[['NeedsImmediateAlert'],['StopVisiblyWithoutTriage']]);
 assert.deepEqual(edges('NeedsImmediateAlert'),[['ReturnQueuedForAutoRecovery'],['StopVisiblyWithoutTriage']]);
 assert(!w.connections.ReturnQueuedForAutoRecovery);
});
test('review-label recovery cannot reach a creator/model',()=>{const seen=new Set(),queue=['RestoreReviewContext'];while(queue.length){const name=queue.shift();if(seen.has(name))continue;seen.add(name);for(const targets of edges(name))queue.push(...targets);}assert(!seen.has('SaveReviewDraft'));assert(!seen.has('ExtractRequestGroq'));assert(seen.has('ApplyReviewAndTriagedLabels'));assert(seen.has('ReadFinalSourceLabels'));assert(seen.has('CompleteLedger'));});
test('completion follows actual source-label read/verification',()=>{assert.deepEqual(edges('OutcomeToVerify')[0],['ReadFinalSourceLabels']);assert.deepEqual(edges('ReadFinalSourceLabels')[0],['VerifyFinalSourceLabels']);assert.deepEqual(edges('VerifyFinalSourceLabels')[0],['CompleteLedger']);});
test('query data uses parameter binding',()=>{for(const node of w.nodes.filter(n=>n.type==='n8n-nodes-base.postgres')){assert(node.parameters.query.includes('$1::jsonb'));assert(!node.parameters.query.includes('{{'));const params=node.parameters.options.queryReplacement;assert(params.startsWith('={{ [JSON.stringify('));assert.equal(node.retryOnFail,false);}});
test('owner transfer carries current expected phase/status/version, mode, and draft_absent_verified',()=>{const e={...autoEvidence,oldExecutionStopped:true,draftAbsentVerified:true};const params=evaluate(n('TransferRecoveryOwnership').parameters.options.queryReplacement,{RecoveryEvidence:e});const payload=JSON.parse(params[0]);assert.equal(payload.expected_owner,'old');assert.equal(payload.expected_phase,'Processing');assert.equal(payload.expected_status,'Running');assert.equal(payload.old_candidate_version,contract.candidate);assert.equal(payload.owner_token,'local-execution');assert.equal(payload.old_execution_stopped,true);assert.equal(payload.mode,'auto');assert.equal(payload.draft_absent_verified,true);});
test('no new runtime Code, queue, schedule, send, or provider strategy',()=>{for(const node of w.nodes){assert(!['n8n-nodes-base.code','n8n-nodes-base.merge','n8n-nodes-base.scheduleTrigger'].includes(node.type));assert(!['send','reply','sendAndWait'].includes(node.parameters.operation));}assert.equal(w.active,false);assert.deepEqual(w.pinData||{},{});});
test('all expression targets and wired nodes exist',()=>{const names=new Set(w.nodes.map(n=>n.name));for(const node of w.nodes)for(const [,name]of JSON.stringify(node.parameters).matchAll(/\$\('([^']+)'\)/g))assert(names.has(name),node.name+' -> '+name);for(const [name,types]of Object.entries(w.connections)){assert(names.has(name));for(const outputs of Object.values(types))for(const targets of outputs)for(const t of targets||[])assert(names.has(t.node));}});
test('raw expressions have one complete delimiter',()=>{for(const node of w.nodes.filter(n=>n.type==='n8n-nodes-base.set'&&n.parameters.mode==='raw')){const s=node.parameters.jsonOutput;assert.deepEqual(s.match(/{{[\s\S]*?}}/g),[s.slice(1)],node.name);}});
test('all new parameter expressions have complete delimiters',()=>{const visit=(v,name)=>{if(typeof v==='string'&&v.startsWith('={{')){assert.deepEqual(v.match(/{{[\s\S]*?}}/g),[v.slice(1)],name);assert(!/\b(?:prototype|__proto__|constructor)\b/.test(v),name+' accesses blocked Tournament sandbox property');}else if(v&&typeof v==='object')for(const c of Object.values(v))visit(c,name);};for(const node of w.nodes.filter(n=>n.id.startsWith('t018-')))visit(node.parameters,node.name);});
test('automated and manual recovery sweeper is a PascalCase 2-swimlane workflow',()=>{
 const rw=JSON.parse(fs.readFileSync('workflows/recover-order-status-request.json'));
 assert.equal(rw.name,'RecoverOrderStatusRequest');
 assert.equal(rw.active,false);
 const nonSticky=rw.nodes.filter(n=>!n.type.endsWith('stickyNote'));
 const sticky=rw.nodes.filter(n=>n.type.endsWith('stickyNote'));
 assert.equal(nonSticky.length,9);
 assert.equal(sticky.length,2);
 for(const node of rw.nodes){
  assert(/^[A-Z][A-Za-z0-9]*$/.test(node.name),node.name);
  assert(!node.type.includes('code')&&!node.type.includes('gmail')&&!node.type.includes('lmChat'),node.name);
 }
 assert(sticky.some(s=>s.name==='RecoveryTriggerLane'&&s.parameters.content.startsWith('## 01')&&s.parameters.color===4));
 assert(sticky.some(s=>s.name==='RecoveryDispatchLane'&&s.parameters.content.startsWith('## 02')&&s.parameters.color===5));
 const rwn=name=>{const v=rw.nodes.find(n=>n.name===name);assert(v,name);return v;};
 assert.deepEqual(rwn('ScheduleRecoverySweep').parameters.rule.interval,[{field:'minutes',minutesInterval:5}]);
 const assignments=rwn('SelectUnresolvedRequest').parameters.assignments.assignments;
 assert.deepEqual(assignments.map(a=>[a.name,a.value,a.type]),[
  ['mode',"={{ $('ScheduleRecoverySweep').isExecuted ? 'auto' : 'manual' }}",'string'],
  ['receiverEmail','controlled-receiver@example.com','string'],
  ['cooldownSeconds',300,'number'],
  ['batchLimit',5,'number'],
  ['settleWindowMs',60000,'number'],
  ['sourceMessageId','','string'],
  ['expectedOwnerToken','','string'],
  ['writesSettled',false,'boolean'],
  ['note','','string'],
  ['acceptChangedVersion',false,'boolean'],
  ['inspectedDraftId','','string']
 ]);
 const autoReq=rwn('BuildAutoRecoveryRequests');
 assert.notEqual(autoReq.parameters.mode,'raw');
 assert.deepEqual(autoReq.parameters.assignments.assignments.map(a=>[a.name,a.value,a.type]),[
  ['mode','auto','string'],
  ['sourceMessageId','={{ $json.record.source_message_id }}','string'],
  ['expectedOwnerToken','={{ $json.record.owner_token }}','string'],
  ['settleWindowMs',"={{ $('SelectUnresolvedRequest').item.json.settleWindowMs }}",'number']
 ]);
 const findNode=rwn('FindRecoverableRequests');
 assert.equal(findNode.type,'n8n-nodes-base.postgres');
 assert.equal(findNode.retryOnFail,false);
 assert.equal(findNode.parameters.query,'SELECT value AS record FROM jsonb_array_elements(public.find_recoverable_order_status_requests($1::jsonb))');
 assert(!findNode.parameters.query.includes('{{'));
 assert(findNode.parameters.options.queryReplacement.startsWith('={{ [JSON.stringify('));
 const findParams=evaluate(findNode.parameters.options.queryReplacement,{SelectUnresolvedRequest:{receiverEmail:'controlled-receiver@example.com',cooldownSeconds:300,batchLimit:5}});
 assert.deepEqual(JSON.parse(findParams[0]),{mailbox:'controlled-receiver@example.com',cooldown_seconds:300,limit:5});
 const callMain=rwn('RecoverThroughMain');
 assert.equal(callMain.onError,'continueErrorOutput');
 assert.equal(callMain.parameters.workflowId.value,'<MAIN_WORKFLOW_ID>');
 assert.equal(callMain.parameters.mode,'each');
 assert.equal(callMain.parameters.workflowInputs.value.request,'={{ $json }}');
 assert.equal(rwn('ReturnRecoveryOutcome').parameters.jsonOutput,'={{ $json }}');
 assert.equal(rwn('VerifySweepBatchOutcome').parameters.errorMessage,'={{ JSON.stringify($json) }}');
 const rwEdges=name=>(rw.connections[name]?.main||[]).map(targets=>(targets||[]).map(t=>t.node));
 assert.deepEqual(rwEdges('ScheduleRecoverySweep')[0],['SelectUnresolvedRequest']);
 assert.deepEqual(rwEdges('StartRecovery')[0],['SelectUnresolvedRequest']);
 assert.deepEqual(rwEdges('SelectUnresolvedRequest')[0],['RouteRecoveryMode']);
 assert.deepEqual(rwEdges('RouteRecoveryMode')[0],['FindRecoverableRequests']);
 assert.deepEqual(rwEdges('RouteRecoveryMode')[1],['RecoverThroughMain']);
 assert.deepEqual(rwEdges('FindRecoverableRequests')[0],['BuildAutoRecoveryRequests']);
 assert.deepEqual(rwEdges('BuildAutoRecoveryRequests')[0],['RecoverThroughMain']);
 assert.deepEqual(rwEdges('RecoverThroughMain')[0],['ReturnRecoveryOutcome']);
 assert.deepEqual(rwEdges('RecoverThroughMain')[1],['VerifySweepBatchOutcome']);
 const rwNames=new Set(rw.nodes.map(n=>n.name));
 const visit=(v,name)=>{if(typeof v==='string'&&v.startsWith('={{')){assert.deepEqual(v.match(/{{[\s\S]*?}}/g),[v.slice(1)],name);assert(!/\b(?:prototype|__proto__|constructor)\b/.test(v),name+' accesses blocked Tournament sandbox property');}else if(v&&typeof v==='object')for(const c of Object.values(v))visit(c,name);};
 for(const node of rw.nodes){
  visit(node.parameters,node.name);
  for(const [,ref]of JSON.stringify(node.parameters).matchAll(/\$\('([^']+)'\)/g))assert(rwNames.has(ref),node.name+' -> '+ref);
 }
 for(const [name,types]of Object.entries(rw.connections)){
  assert(rwNames.has(name));
  for(const outputs of Object.values(types))for(const targets of outputs)for(const t of targets||[])assert(rwNames.has(t.node));
 }
});
test('setup and migration define all 5 RPCs, immutability guards, restricted worker, RLS and no reset',()=>{
 const sql=fs.readFileSync('database/order-status-ledger.sql','utf8');
 const mig=fs.readFileSync('database/migrate-automated-recovery.sql','utf8');
 const ver=fs.readFileSync('database/verify-order-status-ledger.sql','utf8');
 assert.equal((sql.match(/create table /gi)||[]).length,1);
 assert(sql.includes('primary key (mailbox, source_message_id)'));
 assert(sql.includes('on conflict (mailbox,source_message_id) do nothing'));
 assert(sql.includes('for update;'));
 assert(sql.includes('enable row level security'));
 for(const doc of [sql,mig]){
  assert(doc.includes('recovery_attempts'));
  assert(doc.includes('quarantine_order_status_request'));
  assert(doc.includes('find_recoverable_order_status_requests'));
  assert(doc.includes('DraftIntentImmutableConflict'));
  assert(doc.includes('draft_absent_verified'));
  assert(doc.includes('security invoker'));
  assert(!/security definer|\btruncate\b|\bdrop\b|grant all/i.test(doc));
  assert(!/grant[^;]*delete/i.test(doc));
 }
 assert(ver.includes('has_recovery_attempts_column'));
 assert(ver.includes('can_call_quarantine'));
 assert(ver.includes('can_call_find_recoverable'));
});
test('error alerting workflow is a stateless PascalCase 2-swimlane workflow',()=>{
 const ew=JSON.parse(fs.readFileSync('workflows/notify-order-status-error.json'));
 assert.equal(ew.name,'NotifyOrderStatusError');
 assert.equal(ew.active,false);
 assert.deepEqual(ew.pinData||{},{});
 assert.equal(ew.settings.saveDataSuccessExecution,'none');
 assert.equal(ew.settings.saveDataErrorExecution,'all');
 assert.equal(ew.settings.saveManualExecutions,true);
 assert(!('errorWorkflow' in ew.settings));
 const nonSticky=ew.nodes.filter(n=>!n.type.endsWith('stickyNote'));
 const sticky=ew.nodes.filter(n=>n.type.endsWith('stickyNote'));
 assert.equal(nonSticky.length,7);
 assert.equal(sticky.length,2);
 for(const node of ew.nodes){
  assert(/^[A-Z][A-Za-z0-9]*$/.test(node.name),node.name);
  assert(!node.credentials,node.name);
  assert(!node.type.includes('code')&&!node.type.includes('postgres')&&!node.type.includes('gmail')&&!node.type.includes('googleSheets')&&!node.type.includes('lmChat')&&!node.type.includes('dataTable'),node.name);
 }
 assert(sticky.some(s=>s.name==='ErrorTriggerLane'&&s.parameters.content.startsWith('## 01')&&s.parameters.color===4));
 assert(sticky.some(s=>s.name==='ErrorDeliveryLane'&&s.parameters.content.startsWith('## 02')&&s.parameters.color===5));
 const ewn=name=>{const v=ew.nodes.find(n=>n.name===name);assert(v,name);return v;};
 const cfg=ewn('ErrorAlertConfig');
 assert.notEqual(cfg.parameters.mode,'raw');
 assert.deepEqual(cfg.parameters.assignments.assignments.map(a=>[a.name,a.value,a.type]),[
  ['slackChannelId','<SLACK_ERROR_CHANNEL_ID>','string']
 ]);
 const parseNode=ewn('ParseErrorToSlackAlert');
 assert.equal(parseNode.executeOnce,true);
 assert.equal(parseNode.parameters.mode,'raw');
 assert(parseNode.parameters.jsonOutput.includes(require('../src/error-policy').formatErrorAlert.toString()));
 const slackNode=ewn('SendSlackErrorAlert');
 assert.equal(slackNode.type,'n8n-nodes-base.slack');
 assert.equal(slackNode.retryOnFail,true);
 assert.equal(slackNode.maxTries,3);
 assert.equal(slackNode.waitBetweenTries,5000);
 assert.equal(slackNode.parameters.otherOptions.mrkdwn,true);
 assert.equal(slackNode.parameters.otherOptions.link_names,false);
 assert.equal(slackNode.parameters.otherOptions.includeLinkToWorkflow,false);
 const receiptNode=ewn('ReturnAlertReceipt');
 assert.equal(receiptNode.executeOnce,true);
 assert.notEqual(receiptNode.parameters.mode,'raw');
 assert.deepEqual(receiptNode.parameters.assignments.assignments.map(a=>[a.name,a.value,a.type]),[
  ['classification',"={{ $('ParseErrorToSlackAlert').item.json.classification }}",'string'],
  ['channel_id',"={{ $('ErrorAlertConfig').item.json.slackChannelId }}",'string'],
  ['slack_ts',"={{ $('SendSlackErrorAlert').item.json.ts || $('SendSlackErrorAlert').item.json.message?.ts || '' }}",'string']
 ]);
 const ewEdges=name=>(ew.connections[name]?.main||[]).map(targets=>(targets||[]).map(t=>t.node));
 assert.deepEqual(ewEdges('ReceiveWorkflowError')[0],['AlertInputEnvelope']);
 assert.deepEqual(ewEdges('ReceiveAlertRequest')[0],['AlertInputEnvelope']);
 assert.deepEqual(ewEdges('AlertInputEnvelope')[0],['ErrorAlertConfig']);
 assert.deepEqual(ewEdges('ErrorAlertConfig')[0],['ParseErrorToSlackAlert']);
 assert.deepEqual(ewEdges('ParseErrorToSlackAlert')[0],['SendSlackErrorAlert']);
 assert.deepEqual(ewEdges('SendSlackErrorAlert')[0],['ReturnAlertReceipt']);
 const ewNames=new Set(ew.nodes.map(n=>n.name));
 const visit=(v,name)=>{if(typeof v==='string'&&v.startsWith('={{')){assert.deepEqual(v.match(/{{[\s\S]*?}}/g),[v.slice(1)],name);assert(!/\b(?:prototype|__proto__|constructor)\b/.test(v),name+' accesses blocked Tournament sandbox property');}else if(v&&typeof v==='object')for(const c of Object.values(v))visit(c,name);};
 for(const node of ew.nodes){
  visit(node.parameters,node.name);
  for(const [,ref]of JSON.stringify(node.parameters).matchAll(/\$\('([^']+)'\)/g))assert(ewNames.has(ref),node.name+' -> '+ref);
 }
 for(const [name,types]of Object.entries(ew.connections)){
  assert(ewNames.has(name));
  for(const outputs of Object.values(types))for(const targets of outputs)for(const t of targets||[])assert(ewNames.has(t.node));
 }
});
console.log(`${total} focused local recovery/guard/source checks passed. Offline checks only; no database calls, concurrent executions or Gmail operations were performed.`);
