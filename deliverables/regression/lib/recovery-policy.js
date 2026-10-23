'use strict';

function recoveryDecision(record, request, source, candidate) {
  let result = 'Ready';
  if (!record) result = 'LedgerRecordNotFound';
  else if (record.source_message_id !== source.id || record.thread_id !== source.threadId) result = 'SourceMismatchNeedsInspection';
  else if (record.phase === 'Completed') result = 'AlreadyCompleted';
  else if (record.owner_token !== request.expectedOwnerToken) result = 'OwnershipConflict';
  else if (request.writesSettled !== true || typeof request.note !== 'string' || !request.note.trim()) result = 'OperatorInspectionRequired';
  else if (record.candidate_version !== candidate && request.acceptChangedVersion !== true) result = 'CandidateVersionMismatch';
  else if (record.phase === 'DraftIntentRecorded' && !request.inspectedDraftId) result = 'UncertainWriteNeedsInspection';
  return {record, request, result, proceed: result === 'Ready'};
}

function stoppedExecution(evidence, execution, mainId) {
  const r = evidence.record;
  const terminal = ['success','error','canceled','crashed'];
  if (String(execution.id) !== r.execution_id || execution.workflowId !== mainId) {
    throw new Error('PreviousExecutionIdentityMismatchNeedsInspection');
  }
  if (!terminal.includes(execution.status)) {
    return {...evidence, oldExecutionStopped: false, result: 'OwnershipConflict'};
  }
  if (!execution.stoppedAt || evidence.request.writesSettled !== true) {
    throw new Error('PreviousExecutionOrOutstandingWritesNotReconciled');
  }
  return {...evidence, oldExecutionStopped: true};
}

function verifiedDraft(source, saved, readback, confirmDraft) {
  if (typeof source.reply_body !== 'string' || !source.reply_body.trim()) {
    throw new Error('SavedDraftMismatchNeedsInspection');
  }
  const result = confirmDraft(source, saved, readback);
  const extras = [readback.cc, readback.bcc].some(v =>
    typeof v === 'string' ? !!v.trim() : Array.isArray(v?.value) && v.value.length > 0);
  if (result.draft_confirmed !== true || extras ||
      (Array.isArray(readback.labelIds) && !readback.labelIds.includes('DRAFT'))) {
    throw new Error('SavedDraftMismatchNeedsInspection');
  }
  return result;
}

function verifiedLabels(message, source, required) {
  const labels = Array.isArray(message.labelIds) ? message.labelIds :
    Array.isArray(message.labels) ? message.labels.map(label => typeof label === 'string' ? label : label?.id) : [];
  if (message.id !== source.message_id || message.threadId !== source.thread_id ||
      !required.every(id => labels.includes(id))) {
    throw new Error('SourceLabelsNotVerified');
  }
  return {...source, labels_verified: true};
}

module.exports = {recoveryDecision, stoppedExecution, verifiedDraft, verifiedLabels};
