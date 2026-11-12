# Operator Recovery Guide

Use this runbook to operate and supervise the **`RecoverOrderStatusRequest`** workflow, which handles both **automated 5-minute self-healing sweeps (`mode = 'auto'`)** and **manual operator overrides (`mode = 'manual'`)** for quarantined requests.

Before activating or running recovery, ensure you have completed [Setup and Rebinding](setup-and-rebinding.md). For architectural details on ledger states, multi-turn draft reconciliation, and crash boundaries, see [As-Built System Design](system-design.md).

---

## Golden Rules of Recovery

1. **Never delete or reset ledger rows** to retry a message.
2. **Never blindly recreate a Gmail draft** after a timeout—an interrupted request at `DraftIntentRecorded` may have already created a draft in Gmail before the checkpoint completed.
3. **Never recover while the prior execution is still running** or while Gmail API writes are still in flight.

---

## 1. Automated Recovery Sweeps (`mode = 'auto'`)

When `RecoverOrderStatusRequest` is published/active, **`ScheduleRecoverySweep`** runs every 5 minutes to automatically heal transient operational failures without human intervention:

1. **Read-Only Candidate Discovery (`FindRecoverableRequests`):** Calls `public.find_recoverable_order_status_requests($1::jsonb)` using the `OrderStatusLedger` Postgres credential. This pure `SELECT` query returns up to `batchLimit` (default `5`) unresolved rows for `receiverEmail` where:
   - `phase <> 'Completed'`
   - `status IN ('NeedsRecovery', 'Running')` and `(status = 'Running' OR recovery_attempts < 1)`
   - `updated_at <= now() - cooldownSeconds` (default `300` seconds / 5 minutes, minimum floor `90` seconds)
2. **Bounded Liveness & 60-Second Write-Settle Gate:** For each candidate row, `BuildAutoRecoveryRequests` dispatches `{ mode: "auto", sourceMessageId, expectedOwnerToken, settleWindowMs }` through `RecoverThroughMain` (`onError: "continueErrorOutput"`). Phase `00` in `DraftOrderStatusReply` checks the prior execution via the n8n API (`ReadPreviousExecution` + `VerifyPreviousExecutionStopped`):
   - **Active `< 10` minutes:** Defers cleanly (`OwnershipConflict`) so healthy slow executions are never disturbed.
   - **Active $\ge 10$ minutes (Zombie timeout):** Quarantines the row (`PreviousExecutionTimedOutNeedsInspection`) to `status = 'NeedsInspection'` via `QuarantineRecoveryRequest` and fails visibly once.
   - **Terminal `< 60` seconds ago:** Defers cleanly (`WriteSettlePending`) until `settleWindowMs` (default `60000` ms, minimum floor `30000` ms) has elapsed after `stoppedAt`.
   - **Terminal $\ge 60$ seconds ago:** Confirms writes have settled, enforces `max_attempts = 1` (`recovery_attempts < 1`), and proceeds with recovery (or quarantines with `MaxAutoRecoveryAttemptsExhaustedAfterCrash` if a prior auto-retry crashed while `Running`).
3. **Alerting Boundary:**
   - First-time transient failures (`status = 'NeedsRecovery'`, `recovery_attempts = 0`) exit **quietly** via `NeedsImmediateAlert` $\rightarrow$ `ReturnQueuedForAutoRecovery` so they do not trigger false-alarm alerts before the 5-minute sweeper runs.
   - Second failures (`recovery_attempts >= 1`), integrity mismatches, pre-transfer quarantines (`QuarantineRecoveryRequest`), and pre-claim outages route to `StopVisiblyWithoutTriage` (**visible failure**), and `VerifySweepBatchOutcome` surfaces any failed batch item.

---

## 2. Centralized Configuration (`SelectUnresolvedRequest`)

All automated sweep settings and manual override fields live in the single **`SelectUnresolvedRequest`** Set node in [`workflows/recover-order-status-request.json`](../workflows/recover-order-status-request.json):

| Parameter | Mode | Default | Purpose / How to Configure |
| --- | --- | --- | --- |
| `mode` | Both | `={{ $('ScheduleRecoverySweep').isExecuted ? 'auto' : 'manual' }}` | Automatically selects `'auto'` on scheduled sweeps and `'manual'` when triggered via `StartRecovery`. Do not edit this expression. |
| `receiverEmail` | Auto | `controlled-receiver@example.com` | **Required rebinding:** Replace with your authenticated support receiver Gmail address (must match `WorkflowConfig.receiverEmail` in `DraftOrderStatusReply`). |
| `cooldownSeconds` | Auto | `300` | Cooldown before an unresolved row is eligible for a sweep (`300`s = 5 minutes; SQL enforces a minimum floor of `90`s). |
| `batchLimit` | Auto | `5` | Maximum candidate rows recovered per 5-minute sweep (SQL clamps between `1` and `25`). |
| `settleWindowMs` | Auto | `60000` | Required post-`stoppedAt` settle window in milliseconds (`60000` ms = 60 seconds; policy enforces a minimum floor of `30000` ms). |
| `sourceMessageId` | Manual | `""` | Exact `source_message_id` from `public.order_status_ledger` when running a manual recovery. Leave blank for normal operation. |
| `expectedOwnerToken` | Manual | `""` | Exact `owner_token` currently recorded on that ledger row. Leave blank for normal operation. |
| `writesSettled` | Manual | `false` | Set to `true` **only** during a manual override after confirming the prior execution stopped and Gmail writes settled. |
| `note` | Manual | `""` | Non-empty operator audit note explaining what was inspected in n8n/Gmail and why manual recovery is safe. |
| `acceptChangedVersion` | Manual | `false` | Leave `false`. Set to `true` only if `candidate_version` changed and you verified the new workflow version is compatible with the unresolved row. |
| `inspectedDraftId` | Manual | `""` | Leave blank (`""`) unless manually adopting one specific inspected Gmail **draft ID** (not a message ID or thread ID) for a `DraftIntentRecorded` row. |

---

## 3. Manual Operator Recovery Procedure (`StartRecovery`, `mode = 'manual'`)

When a request is quarantined (`status = 'NeedsInspection'`)—because it exhausted its single automated retry (`recovery_attempts >= 1`), hit a `CandidateVersionMismatch`, encountered a 10-minute zombie timeout, or failed `DraftIntentRecorded` reconciliation—automated sweeps skip it. Use **Manual Recovery (`mode = 'manual'`)**, which is unrestricted by `recovery_attempts`, to inspect and override the row:

### Step 1: Inspect the Quarantined Ledger Row
In your Supabase SQL Editor or Table View, locate the row in `public.order_status_ledger` where `status = 'NeedsInspection'` (or `phase <> 'Completed'`) and note:
- `source_message_id` and `thread_id`
- `owner_token`, `execution_id`, and `candidate_version`
- `phase`, `status`, `recovery_attempts`, `last_error`, and `recovery` (including `recovery->'last_quarantine'` and `recovery->'history'`)
- `outcome`, `intent`, `draft_id`, and `draft_message_id`

### Step 2: Inspect the Prior n8n Execution & Gmail Thread
1. **Check the prior n8n execution (`execution_id`):** Verify in the n8n UI that the execution is in a terminal state (`error`, `canceled`, `crashed`, or `success` with `stoppedAt` populated). If it is still running, stop/cancel it and wait at least 60 seconds for any in-flight writes to settle.
2. **Check the Gmail thread (`thread_id`) and drafts:**
   - Verify the source message still exists in the receiver mailbox.
   - Check whether a reply was already sent after the source message, whether multiple drafts exist in the thread, or whether a single draft exists that matches `intent`.
   - If duplicate or corrupted drafts exist in Gmail, delete the unwanted extra draft(s) in Gmail first so the thread state is clean before recovering.

### Step 3: Populate Manual Fields in `SelectUnresolvedRequest` & Execute Once
1. Open **`RecoverOrderStatusRequest`** in n8n (if active, pause/deactivate it briefly while editing manual parameters so a scheduled sweep does not overlap).
2. In **`SelectUnresolvedRequest`**, fill in:
   - `sourceMessageId`: exact `source_message_id` from the ledger row
   - `expectedOwnerToken`: exact `owner_token` from the ledger row
   - `writesSettled`: `true`
   - `note`: brief private explanation of what you inspected and resolved
   - `acceptChangedVersion`: `true` if recovering across a `candidate_version` upgrade, otherwise `false`
   - `inspectedDraftId`: the exact Gmail **draft ID** if adopting a specific draft from `DraftIntentRecorded`, or leave `""` to let Phase `00` run `ReadRecoveryThread` + `ListMailboxDrafts` + `ReconcileUncertainDraft` (which will auto-adopt 1 matching draft or recreate from `intent` when 0 drafts and 0 post-source messages exist)
3. Trigger **`StartRecovery`** (**Execute workflow**) once and verify the row reaches `phase = 'Completed'` and `status = 'Completed'`.
4. Clear the manual override fields (`sourceMessageId: ""`, `expectedOwnerToken: ""`, `writesSettled: false`, `note: ""`, `acceptChangedVersion: false`, `inspectedDraftId: ""`) and save.

---

## 4. Slack Error Alerts (`NotifyOrderStatusError`) & Classification Triage

When **`NotifyOrderStatusError`** ([`workflows/notify-order-status-error.json`](../workflows/notify-order-status-error.json)) is bound under **Workflow Settings → Error Workflow** on `DraftOrderStatusReply` and `RecoverOrderStatusRequest`, its `ParseErrorToSlackAlert` node classifies visible workflow errors and posts a sanitized Slack alert to `#order-status-drafter-alerts` (with zero customer email bodies, draft contents, or prompt text).

### Alerting Boundary
- **Quiet first transient failure (`NeedsRecovery`, `recovery_attempts = 0`):** Exits cleanly via `NeedsImmediateAlert` $\rightarrow$ `ReturnQueuedForAutoRecovery` so the 5-minute sweeper can self-heal without firing false-alarm Slack alerts.
- **Visible failures (`StopVisiblyWithoutTriage`, `VerifySweepBatchOutcome`, or trigger failures):** Fire `NotifyOrderStatusError` only when automatic self-healing is exhausted, unsafe, or unavailable and human action is required.

### Alert Classification to Operator Runbook Mapping

At a high level, every Slack alert falls into one of two parent categories:
1. **Infrastructure / Integration Failure** (`trigger_failure`, `pre_claim_or_unhandled`, `recovery_sweep_failed`) — failed outside a ledger row or during the recovery sweep.
2. **Ledger Status = `NeedsInspection`** (`quarantined_needs_inspection`, `post_claim_needs_inspection`) — a specific ledger row is parked in `status = 'NeedsInspection'` and requires manual recovery (Section 3).

| Parent Category | Alert `classification` | Meaning / Trigger Condition | Operator Next Action |
| --- | --- | --- | --- |
| **Infrastructure / Integration Failure** | **`trigger_failure`** | Pre-execution polling trigger error (`trigger` present without `execution`, e.g., revoked Gmail OAuth token or Schedule Trigger outage). | Inspect the Gmail/Trigger credential in n8n, re-authenticate if expired, and check receiver mailbox connectivity. |
| **Infrastructure / Integration Failure** | **`pre_claim_or_unhandled`** | Failure occurred before a ledger `record` was established or without an attached ledger record (e.g., `ReadMailboxIdentity` auth failure, `ClaimSourceAtomically` DB outage, or unapplied checkpoint/quarantine). | Verify Gmail OAuth2 (`ReadMailboxIdentity`) and Postgres (`ClaimSourceAtomically`) credentials and inspect `public.order_status_ledger` if needed; untriaged messages in Gmail will be picked up once credentials/DB recover. |
| **Infrastructure / Integration Failure** | **`recovery_sweep_failed`** | Failure in `RecoverOrderStatusRequest` (either a sweeper infrastructure failure such as `FindRecoverableRequests` DB outage, or a batch candidate rollup failure at `VerifySweepBatchOutcome` carrying `source_message_id` and `owner_token`). | If `source` / `expectedOwnerToken` are present in the alert, inspect the linked execution or corresponding `DraftOrderStatusReply` alert and follow Section 3 (Manual Recovery); otherwise verify Supabase/Postgres connectivity so the next 5-minute sweep can resume. |
| **Ledger `status = 'NeedsInspection'`** | **`quarantined_needs_inspection`** | Phase `00` `QuarantineRecoveryRequest` transitioned a row to `status = 'NeedsInspection'` (`quarantined: true`, e.g., `PreviousExecutionTimedOutNeedsInspection`, `CandidateVersionMismatch`, or `SavedDraftMismatchNeedsInspection`). | Follow Section 3 (Steps 1–3): inspect the ledger row, prior execution, and Gmail thread, then run a manual override (`mode = 'manual'`). |
| **Ledger `status = 'NeedsInspection'`** | **`post_claim_needs_inspection`** | Post-claim failure with ledger `record` context present (shows header **`Needs Inspection (uncertain Gmail write)`** when `phase = 'DraftIntentRecorded'`, or **`Needs Inspection`** for `Processing`, `DraftSaved`, and `LabelsPending`). | If `phase = 'DraftIntentRecorded'`, **check Gmail thread drafts first** (Section 3, Step 2), remove any duplicate/corrupted drafts, and run manual recovery (`StartRecovery`) with `inspectedDraftId` (or leave blank for automatic single-draft reconciliation). For other phases, inspect `last_error` / n8n execution log, verify external services, and run manual recovery (Section 3). |

### Fallback When Slack Is Unreachable
`SendSlackErrorAlert` retries up to 3 times (`maxTries: 3`, `waitBetweenTries: 3000` ms). If Slack remains unreachable, `NotifyOrderStatusError` fails without looping (`errorWorkflow` is never set on `NotifyOrderStatusError` itself) and stores its execution record (`saveDataErrorExecution: "all"`). If you suspect Slack delivery is down, open **n8n → Executions**, filter by workflow **`NotifyOrderStatusError`** and status **`Error`**, and inspect the raw error trigger payload directly.

---

## 5. Recovery Behavior by Ledger Phase

| Recorded `phase` | Automated (`mode = 'auto'`) & Manual (`mode = 'manual'`) Action Taken |
| --- | --- |
| **`Processing`** | Transfers ownership (`recovery_attempts + 1`) and re-runs validation, extraction, order lookup, and drafting from the live Gmail source. |
| **`DraftIntentRecorded`** *(Case A — 1 matching draft)* | `ReadRecoveryThread` + `ListMailboxDrafts` + `ReconcileUncertainDraft` (or manual `inspectedDraftId`) locates the single draft, verifies it matches `record.intent` via `ReadInspectedDraft` + `VerifyInspectedDraft`, adopts `draft_id` and `draft_message_id` into `DraftSaved`, confirms, and applies labels (**0 LLM/Sheets calls**). |
| **`DraftIntentRecorded`** *(Case B — 0 drafts & 0 post-source messages)* | Confirms 0 drafts in both `thread.get` and `draft.getAll` and 0 non-draft messages after `source_message_id`, transfers ownership keeping `DraftIntentRecorded` (`draft_absent_verified = true`), and routes through `RestoreRecordedIntent` $\rightarrow$ `SharedReplyContext` $\rightarrow$ `RecheckAllowedRecipient` $\rightarrow$ `RecordDraftIntent` (immutable intent check) $\rightarrow$ `SaveReviewDraft` to create the draft from persisted `record.intent` (**0 LLM/Sheets calls**). |
| **`DraftIntentRecorded`** *(Case C — Ambiguous or modified)* | If a post-source message exists (`SentOrNewerMessageAfterSourceNeedsInspection`), `> 1` drafts exist (`MultipleDraftsInThreadNeedsInspection`), `thread.get` and `draft.getAll` disagree (`DraftThreadListInconsistentNeedsInspection`), or the draft fails content/metadata verification (`SavedDraftMismatchNeedsInspection`), `QuarantineRecoveryRequest` sets `status = 'NeedsInspection'` and fails visibly at `StopVisiblyWithoutTriage`. |
| **`DraftSaved`** | Reads and verifies the existing Gmail draft (`draft_id`), applies missing source labels, verifies labels, and marks the row `Completed` (**0 LLM/Sheets calls**). |
| **`LabelsPending`** (`draft_ready`) | Re-verifies the existing Gmail draft, applies/verifies the `triaged` label on the source email, and completes the ledger row (**0 LLM/Sheets calls**). |
| **`LabelsPending`** (`manual_review`) | Applies and verifies `needs-review` and `triaged` labels on the source email and completes the ledger row (**0 LLM/Sheets calls**). |
| **`Completed` / Owner mismatch / Active `< 10m` / Settle `< 60s`** | Returns a read-only skip or deferral (`AlreadyCompleted`, `AlreadyQuarantined`, `OwnershipConflict`, or `WriteSettlePending`) without mutating Gmail or the ledger. |

---

## 6. Audit Trail & Privacy

- Every recovery transfer and quarantine action updates the ledger row in place, incrementing `recovery_attempts` (on transfer) and appending a structured entry to `recovery.history` while updating top-level summary fields (`previous_owner`, `previous_execution`, `previous_candidate`, `previous_phase`, `mode`, `attempt`, `note`, `inspected_draft_id`, `draft_absent_verified`, `last_quarantine`, and `result`).
- Keep `intent` bodies, message/draft IDs, and `recovery` notes private. Follow [Ledger Database Setup](ledger-database-setup.md) when backing up or migrating the database.
