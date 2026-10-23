'use strict';
// Independent evidence assertions. Never imports main-policy or computes a business route.
function canonical(value) {
 if(Array.isArray(value))return value.map(canonical);
 if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])]));
 return value;
}
function graph(w){return JSON.stringify(canonical({nodes:w.nodes,connections:w.connections,settings:w.settings,nodeGroups:w.nodeGroups||[]}));}
function values(run,name){return (run[name]||[]).flatMap(r=>(r.data?.main||[]).flat().map(i=>i.json));}
function labels(m){return (m?.labelIds||m?.labels||[]).map(l=>typeof l==='string'?l:l.id);}
function header(m,name){return m?.[name.toLowerCase()]||m?.[name]||m?.headers?.[name.toLowerCase()]||m?.payload?.headers?.find(h=>h.name.toLowerCase()===name.toLowerCase())?.value;}
function address(v){if(v?.value)return v.value.map(a=>a.address?.trim().toLowerCase());if(typeof v==='string'){const m=v.match(/<([^<>]+)>/);return [(m?m[1]:v).trim().toLowerCase()];}return [];}
function plainText(message){
 if(typeof message?.text==='string')return message.text;
 const visit=part=>{if(part?.mimeType==='text/plain'&&typeof part.body?.data==='string')return Buffer.from(part.body.data,'base64').toString('utf8');for(const child of part?.parts||[]){const text=visit(child);if(text!==null)return text;}return null;};
 return visit(message?.payload)||'';
}
function assess(fixture,execution,thread,config,sourceId){
 const checks=[],expected=fixture.expected,run=execution.data?.resultData?.runData||{},wf=execution.workflowData||execution.data?.workflowData;
 const check=(name,want,got)=>checks.push({name,expected:want,observed:got,pass:JSON.stringify(want)===JSON.stringify(got)});
 const required=(name,pass,observed)=>checks.push({name,expected:true,observed,pass:!!pass});
 const source=values(run,'ReceivePendingDemo').find(v=>v.id===sourceId);
 const messages=thread.messages||[],mail=messages.find(m=>m.id===sourceId),drafts=messages.filter(m=>labels(m).includes('DRAFT'));
 const outcome=values(run,'DraftOutcome').concat(values(run,'ReviewOutcome')).find(v=>v.message_id===sourceId);
 const lookup=values(run,'GetOrderDeterministically');
 const writers=['WriteVerifiedReplyGroq','WriteVerifiedReplyOpenRouter'].flatMap(n=>run[n]||[]);
 const successfulWriters=writers.filter(r=>r.executionStatus==='success');
 check('execution_success','success',execution.status);
 check('candidate_version',config.mainVersion,execution.workflowVersionId||wf?.versionId);
 required('runtime_unpinned',execution.mode==='trigger'&&Object.keys(execution.data?.resultData?.pinData||{}).length===0, Object.keys(execution.data?.resultData?.pinData||{}));
 required('source_execution_identity',!!source&&source.threadId===thread.id&&source.subject===fixture.subject,source?{id:source.id,threadId:source.threadId,subject:source.subject}:null);
 required('source_mailbox_identity',!!mail&&header(mail,'Subject')===fixture.subject,mail?{id:mail.id,subject:header(mail,'Subject')}:null);
 check('authenticated_source_address',[fixture.senderMode==='self'?config.receiver:config.customer],address(header(mail,'From')));
 check('source_recipient',[config.receiver],address(header(mail,'To')));
 check('outcome',expected.outcome,outcome?.outcome);
 check('lookup_count',expected.lookup?1:0,lookup.length);
 if(expected.lookup)check('lookup_status',expected.lookup,lookup[0]?.lookup_status);
 check('lookup_call_count',expected.lookup?1:0,(run.GetOrderDeterministically||[]).length);
 if(config.ledgerCandidate){
  const claim=values(run,'ClaimResult')[0]?.claim,record=values(run,'CompleteLedger')[0]?.record;
  required('ledger_claim_owned',claim?.acquired===true&&claim.result==='Claimed'&&claim.record?.owner_token===String(execution.id),claim);
  check('ledger_candidate',config.ledgerCandidate,record?.candidate_version);
  check('ledger_source',sourceId,record?.source_message_id);
  check('ledger_mailbox',config.receiver,record?.mailbox);
  check('ledger_owner',String(execution.id),record?.owner_token);
  check('ledger_completed_phase','Completed',record?.phase);
  check('ledger_completed_status','Completed',record?.status);
  check('ledger_outcome',expected.outcome,record?.outcome);
  const claimIndex=run.ClaimResult?.[0]?.executionIndex,work=run.PrepareSourceContext?.[0]?.executionIndex;
  required('claim_before_business',Number.isFinite(claimIndex)&&claimIndex<work,{claimIndex,work});
  const labelIndex=run.VerifyFinalSourceLabels?.[0]?.executionIndex,completeIndex=run.CompleteLedger?.[0]?.executionIndex;
  required('labels_verified_before_completion',values(run,'VerifyFinalSourceLabels')[0]?.labels_verified===true&&labelIndex<completeIndex,{labelIndex,completeIndex});
  if(expected.outcome==='draft_ready'){
   check('ledger_draft_id',outcome?.draft_id,record?.draft_id);
   const intent=run.RecordDraftIntent?.[0]?.executionIndex,save=run.SaveReviewDraft?.[0]?.executionIndex,saved=run.RecordSavedDraft?.[0]?.executionIndex,read=run.ReadSavedDraft?.[0]?.executionIndex;
   required('durable_draft_ordering',intent<save&&save<saved&&saved<read,{intent,save,saved,read});
  }
 }
 if(expected.drafting)required('drafting_success',successfulWriters.length===1,successfulWriters.length);
 else check('drafting_call_count',0,writers.length);
 check('draft_count',expected.outcome==='draft_ready'?1:0,drafts.length);
 required('source_triaged',labels(mail).includes(config.labels.triaged),labels(mail));
 check('source_review_label',expected.outcome==='manual_review',labels(mail).includes(config.labels.review));
 check('sent_customer_reply_count',0,messages.filter(m=>m.id!==sourceId&&labels(m).includes('SENT')).length);
 if(expected.outcome==='manual_review'){
  required('visible_review_reason',typeof outcome?.reason==='string'&&!!outcome.reason.trim(),outcome?.reason);
  if(expected.reason)check('review_reason',expected.reason,outcome?.reason);
  if(expected.reasonPattern)required('review_reason_category',new RegExp(expected.reasonPattern,'i').test(outcome?.reason||''),outcome?.reason);
  check('draft_save_call_count',0,(run.SaveReviewDraft||[]).length);
 }
 if(expected.outcome==='draft_ready'){
  check('draft_save_call_count',1,(run.SaveReviewDraft||[]).length);
  check('draft_readback_call_count',1,(run.ReadSavedDraft||[]).length);
  const draft=drafts[0],body=plainText(draft),readback=values(run,'ReadSavedDraft')[0],confirmed=values(run,'ConfirmSavedDraft')[0];
  check('draft_recipient',[config.customer],address(header(draft,'To')));
  check('draft_subject',fixture.subject,header(draft,'Subject'));
  check('draft_thread',thread.id,draft?.threadId);
  check('draft_confirmed',true,confirmed?.draft_confirmed);
  required('draft_id_readback',!!outcome?.draft_id&&outcome.draft_id===readback?.id&&draft?.id===outcome.draft_message_id,{draftId:outcome?.draft_id,messageId:draft?.id,readbackId:readback?.id});
  const confirmIndex=run.ConfirmSavedDraft?.[0]?.executionIndex,triageIndex=run.MarkConfirmedDraftTriaged?.[0]?.executionIndex;
  required('confirmation_before_triage',Number.isFinite(confirmIndex)&&confirmIndex<triageIndex,{confirmIndex,triageIndex});
  check('readback_body',body.trim(),readback?.text?.trim());
  if(expected.template)check('fixed_template_exact',expected.template,body.trim());
  if(expected.status)required('supplied_status',new RegExp('\\b'+expected.status+'\\b','i').test(body),body);
  if(expected.tracking)required('supplied_tracking',body.includes(expected.tracking),body);
  if(expected.estimate)required('qualified_estimate',body.includes(expected.estimate)&&/estimat|expected|approximately|around/i.test(body),body);
  required('no_urls',!/(https?:\/\/|www\.)/i.test(body),body);
  const allowedDates=expected.estimate?[expected.estimate]:[];
  check('unexpected_iso_dates',[],[...new Set(body.match(/\b\d{4}-\d{2}-\d{2}\b/g)||[])].filter(x=>!allowedDates.includes(x)));
  required('no_other_order_facts',!(/1002|1003|TRK1002|TRK1003/.test(body)&&expected.orderNumber==='1001')&&!(expected.orderNumber==='1002'&&/TRK\d+/.test(body)),body);
  required('no_promised_action',!/(?:we(?:'ll| will)|I(?:'ll| will)) (?:contact|expedite|resend|refund|cancel|dispatch|ship|investigate)/i.test(body),body);
  if(expected.status==='processing')required('dispatch_unknown',/not (?:yet )?(?:available|provided|known)|(?:do not|don't|cannot|can't) (?:have|confirm|provide)|no (?:confirmed |specific )?(?:dispatch|shipping|shipment) (?:date|time)|has(?:n't| not) (?:yet )?been (?:provided|supplied|confirmed)|(?:dispatch|shipping|shipment) (?:date|time) (?:is |remains )?(?:currently |still )?(?:unknown|unavailable|not (?:yet )?(?:known|provided|confirmed))/i.test(body),body);
  if(expected.status==='delivered')required('no_invented_delivery_date',!/(?:delivered|arrived) (?:on|at|yesterday|today|last|this)|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i.test(body),body);
 }
 if(expected.cleanExcludes){
  const cleaned=values(run,'CleanCustomerQuestion')[0]?.cleaned_question;
  required('quoted_order_removed',typeof cleaned==='string'&&!cleaned.includes(expected.cleanExcludes),cleaned);
  const input=values(run,'ValidatedRequest')[0],draftInput=values(run,'ResolveOrderRequest')[0];
  check('shared_cleaned_input',cleaned,input?.cleaned_question);check('draft_cleaned_input',cleaned,draftInput?.cleaned_question);
 }
 return {assertionRevision:'T018-observer-2026-10-20',caseId:fixture.id,status:checks.every(c=>c.pass)?'PASS':'FAIL',executionId:execution.id,sourceId,threadId:thread.id,draftId:outcome?.draft_id||null,reason:outcome?.reason||'',draftText:drafts.length?plainText(drafts[0]):null,checks};
}
function summary(state,restored,versionStable){
 const cases=state.cases.map(c=>state.results.find(r=>r.caseId===c.id)||{caseId:c.id,status:'NOT_RUN'});
 const pass=!state.error&&restored&&versionStable&&cases.length===state.planned&&cases.every(c=>c.status==='PASS')&&state.sent===state.planned;
 return {mode:state.mode,label:(state.mode==='demo'?'Demo Essentials':'Regression')+' — '+cases.filter(c=>c.status==='PASS').length+'/'+state.planned,status:pass?'PASS':!restored?'CLEANUP_FAILED':!versionStable?'VERSION_MISMATCH':state.error?.code||'FAIL',planned:state.planned,sent:state.sent,completed:state.results.filter(r=>r.executionId).length,observedResults:state.results.length,notRun:cases.filter(c=>c.status==='NOT_RUN').length,mainVersion:state.config.mainVersion,childVersion:state.config.childVersion,fixtureRevision:state.fixtureRevision,restored,versionStable,error:state.error||null,cases,humanWordingReview:'PENDING'};
}
module.exports={canonical,graph,values,labels,header,address,assess,summary};
