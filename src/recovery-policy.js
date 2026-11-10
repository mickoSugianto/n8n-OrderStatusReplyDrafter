'use strict';

function recoveryDecision(record, request, source, candidate) {
  const mode = request?.mode === 'auto' ? 'auto' : 'manual';
  if (source?.error) {
    return {
      record,
      request,
      result: 'SourceReadFailedNeedsInspection',
      proceed: false,
      quarantine: true,
      error: typeof source.error === 'string' ? source.error : source.error?.message || source.message || 'SourceReadFailedNeedsInspection'
    };
  }
  if (!record) {
    return {record, request, result: 'LedgerRecordNotFound', proceed: false, quarantine: false};
  }
  if (!source || record.source_message_id !== source.id || record.thread_id !== source.threadId) {
    return {record, request, result: 'SourceMismatchNeedsInspection', proceed: false, quarantine: true, error: 'SourceMismatchNeedsInspection'};
  }
  if (record.phase === 'Completed') {
    return {record, request, result: 'AlreadyCompleted', proceed: false, quarantine: false};
  }
  if (record.owner_token !== request?.expectedOwnerToken) {
    return {record, request, result: 'OwnershipConflict', proceed: false, quarantine: false};
  }
  if (mode === 'auto' && record.status === 'NeedsInspection') {
    return {record, request, result: 'AlreadyQuarantined', proceed: false, quarantine: false};
  }
  if (mode === 'auto' && Number(record.recovery_attempts) >= 1 && record.status !== 'Running') {
    return {record, request, result: 'MaxAttemptsReached', proceed: false, quarantine: true, error: 'MaxAttemptsReached'};
  }
  if (mode !== 'auto' && (request?.writesSettled !== true || typeof request?.note !== 'string' || !request.note.trim())) {
    return {record, request, result: 'OperatorInspectionRequired', proceed: false, quarantine: false};
  }
  if (record.candidate_version !== candidate && request?.acceptChangedVersion !== true) {
    return {
      record,
      request,
      result: 'CandidateVersionMismatch',
      proceed: false,
      quarantine: mode === 'auto',
      error: mode === 'auto' ? 'CandidateVersionMismatch' : undefined
    };
  }
  if (mode !== 'auto' && record.phase === 'DraftIntentRecorded' && !request?.inspectedDraftId) {
    return {record, request, result: 'UncertainWriteNeedsInspection', proceed: false, quarantine: false};
  }
  return {record, request, result: 'Ready', proceed: true, quarantine: false};
}

function stoppedExecution(evidence, execution, mainId, nowMs = Date.now()) {
  const r = evidence.record;
  const req = evidence.request || {};
  const mode = req.mode === 'auto' ? 'auto' : 'manual';
  const terminal = ['success', 'error', 'canceled', 'crashed'];
  if (!execution || execution.error || String(execution.id) !== r.execution_id || execution.workflowId !== mainId) {
    return {
      ...evidence,
      oldExecutionStopped: false,
      result: 'PreviousExecutionMissingOrMismatchNeedsInspection',
      quarantine: true,
      error: 'PreviousExecutionMissingOrMismatchNeedsInspection'
    };
  }
  if (!terminal.includes(execution.status)) {
    const startedMs = Date.parse(execution.startedAt || r.updated_at || r.created_at);
    if (Number.isFinite(startedMs) && nowMs - startedMs >= 600000) {
      return {
        ...evidence,
        oldExecutionStopped: false,
        result: 'PreviousExecutionTimedOutNeedsInspection',
        quarantine: true,
        error: 'PreviousExecutionTimedOutNeedsInspection'
      };
    }
    return {...evidence, oldExecutionStopped: false, result: 'OwnershipConflict', quarantine: false};
  }
  if (!execution.stoppedAt || !Number.isFinite(Date.parse(execution.stoppedAt))) {
    return {
      ...evidence,
      oldExecutionStopped: false,
      result: 'PreviousExecutionOrOutstandingWritesNotReconciled',
      quarantine: true,
      error: 'PreviousExecutionOrOutstandingWritesNotReconciled'
    };
  }
  if (mode === 'auto' && Number(r.recovery_attempts) >= 1) {
    return {
      ...evidence,
      oldExecutionStopped: true,
      result: 'MaxAutoRecoveryAttemptsExhaustedAfterCrash',
      quarantine: true,
      error: 'MaxAutoRecoveryAttemptsExhaustedAfterCrash'
    };
  }
  if (mode === 'auto') {
    const settleWindowMs = Math.max(Number(req.settleWindowMs) || 60000, 30000);
    if (nowMs - Date.parse(execution.stoppedAt) < settleWindowMs) {
      return {...evidence, oldExecutionStopped: false, result: 'WriteSettlePending', quarantine: false};
    }
    return {
      ...evidence,
      request: {
        ...req,
        mode: 'auto',
        writesSettled: true,
        note: typeof req.note === 'string' && req.note.trim()
          ? req.note.trim()
          : 'Auto-recovery verified stopped execution ' + execution.id + ' (' + execution.status + ') after settle window.'
      },
      oldExecutionStopped: true,
      result: 'Ready',
      quarantine: false
    };
  }
  if (req.writesSettled !== true) {
    return {
      ...evidence,
      oldExecutionStopped: false,
      result: 'PreviousExecutionOrOutstandingWritesNotReconciled',
      quarantine: false,
      error: 'PreviousExecutionOrOutstandingWritesNotReconciled'
    };
  }
  return {...evidence, oldExecutionStopped: true, result: 'Ready', quarantine: false};
}

function reconcileThreadAndDrafts(record, thread, draftList) {
  const labels = m => Array.isArray(m?.labelIds) ? m.labelIds :
    Array.isArray(m?.labels) ? m.labels.map(l => typeof l === 'string' ? l : l?.id).filter(Boolean) : [];
  if (!thread || thread.error || !Array.isArray(thread.messages) || !Array.isArray(draftList) || draftList.some(d => d?.error)) {
    return {quarantine: true, result: 'GmailThreadOrDraftReadFailedNeedsInspection', error: 'GmailThreadOrDraftReadFailedNeedsInspection'};
  }
  const sourceIndex = thread.messages.findIndex(m => m && m.id === record.source_message_id);
  if (sourceIndex === -1) {
    return {quarantine: true, result: 'SourceMessageMissingFromThreadNeedsInspection', error: 'SourceMessageMissingFromThreadNeedsInspection'};
  }
  const messagesAfterSource = thread.messages.slice(sourceIndex + 1).filter(m => !labels(m).includes('DRAFT'));
  if (messagesAfterSource.length > 0) {
    return {quarantine: true, result: 'SentOrNewerMessageAfterSourceNeedsInspection', error: 'SentOrNewerMessageAfterSourceNeedsInspection'};
  }
  const threadDraftMessages = thread.messages.filter(m => labels(m).includes('DRAFT'));
  const mailboxDraftsInThread = draftList.filter(d => d && typeof d.id === 'string' && d.id && (d.message?.threadId || d.threadId) === record.thread_id);
  if (threadDraftMessages.length !== mailboxDraftsInThread.length) {
    return {quarantine: true, result: 'DraftThreadListInconsistentNeedsInspection', error: 'DraftThreadListInconsistentNeedsInspection'};
  }
  if (mailboxDraftsInThread.length > 1) {
    return {quarantine: true, result: 'MultipleDraftsInThreadNeedsInspection', error: 'MultipleDraftsInThreadNeedsInspection'};
  }
  if (mailboxDraftsInThread.length === 1) {
    const draft = mailboxDraftsInThread[0];
    const draftMsgId = draft.message?.id || draft.messageId || null;
    if (!draftMsgId || draftMsgId !== threadDraftMessages[0]?.id) {
      return {quarantine: true, result: 'DraftThreadListInconsistentNeedsInspection', error: 'DraftThreadListInconsistentNeedsInspection'};
    }
    return {quarantine: false, result: 'InspectSingleDraft', resolution: 'InspectSingleDraft', inspectedDraftId: draft.id, draftMessageId: draftMsgId};
  }
  return {quarantine: false, result: 'AbsentCreateFromIntent', resolution: 'AbsentCreateFromIntent', draftAbsentVerified: true};
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

module.exports = {recoveryDecision, stoppedExecution, reconcileThreadAndDrafts, verifiedDraft, verifiedLabels};
