# Operator Recovery Guide

Use this runbook to safely recover a single interrupted or failed order-status request using the **`RecoverOrderStatusRequest`** workflow.

Recovery is **strictly manual and supervised**. Before running any recovery action, ensure you have completed [Setup and Rebinding](setup-and-rebinding.md). For architectural details on ledger states and crash boundaries, see [As-Built System Design](system-design.md).

---

## Golden Rules of Recovery

1. **Never delete or reset ledger rows** to retry a message.
2. **Never blindly recreate a Gmail draft** after a timeout—an interrupted request may have already created a draft in Gmail before the checkpoint completed.
3. **Never recover while the prior execution is still running** or while Gmail API writes are still in flight.

---

## Step-by-Step Recovery Procedure

### Step 1: Inspect the Unresolved Ledger Row
In your Supabase SQL Editor or Table View, locate the unresolved row in `public.order_status_ledger` for your receiver mailbox and note:
- `source_message_id`
- `owner_token`
- `phase` and `status` (`Running`, `NeedsRecovery`, or `NeedsInspection`)
- `execution_id` and `candidate_version`
- `outcome`, `draft_id`, and `draft_message_id`

### Step 2: Inspect the Prior n8n Execution & Gmail Thread
1. **Check the prior n8n execution (`execution_id`):** If it is still running or waiting, stop/cancel it and wait until it reaches a terminal state (`error`, `canceled`, `crashed`, or `success` with `stoppedAt` populated).
2. **Check Gmail:** Open the source message and thread in the receiver's Gmail mailbox. Check whether a draft was already created or labels were already applied.
   - *If you cannot determine whether the prior execution has stopped or whether an in-flight write has settled, stop here and leave the row unresolved.*

### Step 3: Configure `SelectUnresolvedRequest`
Open **`RecoverOrderStatusRequest`** in n8n and fill in the **`SelectUnresolvedRequest`** node parameters:

| Parameter | How to Fill It |
| --- | --- |
| `sourceMessageId` | Exact `source_message_id` from the ledger row |
| `expectedOwnerToken` | Exact `owner_token` currently recorded on that ledger row |
| `writesSettled` | Set to `true` **only** after confirming Step 2 (prior execution stopped and Gmail writes settled) |
| `note` | Brief private note describing what you inspected in n8n/Gmail and why recovery is safe |
| `acceptChangedVersion` | Leave `false`. Only set `true` if `candidate_version` changed and you have verified the new workflow version is safe for this row |
| `inspectedDraftId` | Leave blank (`""`) **unless** recovering from `DraftIntentRecorded` by adopting one specific existing draft you inspected in Gmail (must be the Gmail **draft ID**, not a message ID or thread ID) |

### Step 4: Execute Once and Verify
Click **Execute workflow** once in `RecoverOrderStatusRequest`.

The workflow calls the main workflow's recovery entry, re-reads the live Gmail source message and authenticated mailbox profile, verifies via the n8n API that the prior execution is terminal, and performs an atomic compare-and-swap ownership transfer in PostgreSQL.

---

## Recovery Behavior by Ledger Phase

| Recorded `phase` | Recovery Action Taken |
| --- | --- |
| **`Processing`** | Transfers ownership and re-runs validation, extraction, order lookup, and drafting from the live Gmail source. |
| **`DraftSaved`** | Reads and verifies the existing Gmail draft (`draft_id`), applies missing source labels, verifies labels, and marks the row `Completed`. **No model calls or new draft creation.** |
| **`LabelsPending`** (`draft_ready`) | Re-verifies the existing Gmail draft, applies/verifies the `triaged` label on the source email, and completes the ledger row. |
| **`LabelsPending`** (`manual_review`) | Applies and verifies `needs-review` and `triaged` labels on the source email and completes the ledger row—no extraction, lookup, or drafting. |
| **`DraftIntentRecorded`** (blank `inspectedDraftId`) | **Refuses recovery** with `UncertainWriteNeedsInspection`. No ownership transfer or draft creation occurs because Gmail may or may not have created the draft before the crash. |
| **`DraftIntentRecorded`** (with `inspectedDraftId`) | Reads the specified draft under the receiver credential, verifies it matches the persisted `intent` (recipient, thread, subject, trimmed plain-text body, `DRAFT` status, and no extra `CC`/`BCC`), adopts its `draft_id` and `draft_message_id` into `DraftSaved`, and finishes confirmation and labels. |
| **Completed / Owner mismatch / Active execution** | Returns a read-only skip or conflict (`AlreadyCompleted`, `OwnershipConflict`, or `OperatorInspectionRequired`) without mutating Gmail or the ledger. |

---

## What Cannot Be Recovered Automatically

Recovery will refuse and keep the row for manual inspection if:
- The saved draft was already sent, deleted, or modified (recipient, subject, thread, non-whitespace body changes, or added `CC`/`BCC`).
- The prior n8n execution is still running or its status cannot be verified via the n8n API.
- The phase is `DraftIntentRecorded` and no existing draft exists to adopt (deciding to create a brand-new draft after an uncertain write requires manual human handling outside generic recovery).

---

## Audit Trail & Privacy

- A successful recovery updates the ledger row in place, recording the previous owner, execution ID, candidate version, operator note, inspected draft ID (if used), and completion timestamp inside the `recovery` JSONB column.
- Keep `intent` bodies, message/draft IDs, and operator `recovery` notes private. Follow [Ledger Database Setup](ledger-database-setup.md) when backing up or migrating the database.
