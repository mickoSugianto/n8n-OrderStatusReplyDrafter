# Setup and Rebinding Guide

This guide covers step-by-step installation, credential binding, Google Sheets setup, and initial verification for the Order-Status Reply Drafter.

For system architecture and data contracts, see [As-Built System Design](system-design.md). For a quick lookup of all `<...>` placeholders, see [Destination Rebinding Checklist](rebinding-map.md).

---

## Step 1: Set Up the Ledger Database

Before importing workflows, provision or upgrade the PostgreSQL ledger in Supabase by following [Ledger Database Setup](ledger-database-setup.md) (running [`database/order-status-ledger.sql`](../database/order-status-ledger.sql) for a new database or [`database/migrate-automated-recovery.sql`](../database/migrate-automated-recovery.sql) for an existing deployment, then verifying all 18 checks in [`database/verify-order-status-ledger.sql`](../database/verify-order-status-ledger.sql)).

---

## Step 2: Import the Core Workflows (Inactive)

Import the following four workflow exports into n8n and keep them **inactive** during configuration:
1. [`workflows/get-order.json`](../workflows/get-order.json) (`GetOrder`)
2. [`workflows/notify-order-status-error.json`](../workflows/notify-order-status-error.json) (`NotifyOrderStatusError`)
3. [`workflows/main-workflow.json`](../workflows/main-workflow.json) (`DraftOrderStatusReply`)
4. [`workflows/recover-order-status-request.json`](../workflows/recover-order-status-request.json) (`RecoverOrderStatusRequest`)

---

## Step 3: Create and Bind Credentials

Create or select credentials in n8n and explicitly verify the bound account on **every** credentialed node (including all four LLM subnodes and the HTTP Request profile node). Never hardcode API keys or secrets in node expressions.

| Credential Type | Nodes to Bind |
| --- | --- |
| **Gmail OAuth2 API** (`gmailOAuth2`) | All Gmail trigger, message read, thread read, draft list/create/read, and label nodes in `DraftOrderStatusReply` (`ReceivePendingDemo`, `ReadRecoverySource`, `ReadRecoveryThread`, `ListMailboxDrafts`, `ReadInspectedDraft`, `SaveReviewDraft`, `ReadSavedDraft`, `MarkConfirmedDraftTriaged`, `ApplyReviewAndTriagedLabels`, `ReadFinalSourceLabels`), plus the `ReadMailboxIdentity` HTTP Request node |
| **Postgres** (`postgres`) | All 10 ledger nodes in `DraftOrderStatusReply` (`ReadRecoveryRecord`, `QuarantineRecoveryRequest`, `TransferRecoveryOwnership`, `ClaimSourceAtomically`, `RecordDraftIntent`, `RecordSavedDraft`, `RecordDraftLabelsPending`, `RecordReviewLabelsPending`, `CompleteLedger`, `RecordUnfinishedWork`) **and** `FindRecoverableRequests` in `RecoverOrderStatusRequest` (use the restricted `OrderStatusLedger` credential with SSL enabled) |
| **n8n API** (`n8nApi`) | `ReadPreviousExecution` in `DraftOrderStatusReply` (pointed to your destination instance `/api/v1` URL for recovery checks) |
| **Google Sheets OAuth2 API** (`googleSheetsOAuth2Api`) | `ReadAllOrders` in `GetOrder` |
| **Groq API** (`groqApi`) | `GroqExtractionModel` and `GroqDraftingModel` subnodes |
| **OpenRouter API** (`openRouterApi`) | `OpenRouterExtractionModel` and `OpenRouterDraftingModel` subnodes |
| **Slack API** (`slackApi`) | `SendSlackErrorAlert` in `NotifyOrderStatusError` (invite your Slack bot/app to `#order-status-drafter-alerts` and ensure your n8n editor base URL / `WEBHOOK_URL` is configured so `execution.url` links are populated in alerts) |

*Note: Ensure Google Drive API is enabled in your Google Cloud project if n8n requires it for spreadsheet resource discovery.*

---

## Step 4: Configure Controlled Accounts & Allowlists

The demonstration design uses **two controlled email accounts**:
- **Customer sender account** (sends test order inquiries)
- **Support receiver account** (the Gmail inbox watched by n8n)

Update the email fields in the centralized **`WorkflowConfig`** Edit Fields node (Phase `01` of `DraftOrderStatusReply`) and in **`SelectUnresolvedRequest`** (`RecoverOrderStatusRequest`):
1. **`customerEmail` (`WorkflowConfig`):** Replace `controlled-sender@example.com` with your controlled customer sender email.
2. **`receiverEmail` (`WorkflowConfig` and `SelectUnresolvedRequest`):** Replace `controlled-receiver@example.com` with your authenticated receiver Gmail address in both workflows.
   - *(Downstream nodes in `DraftOrderStatusReply`—`VerifyMailboxAndSource`, `ValidateRequestInput`, `RecheckAllowedRecipient`, and `ConfirmSavedDraft`—automatically read both addresses from `WorkflowConfig`. Allowing the receiver address in the allowlist supports the receiver-to-self sender-ownership mismatch test scenario `S08`. In `RecoverOrderStatusRequest`, `FindRecoverableRequests` reads `receiverEmail` from `SelectUnresolvedRequest`.)*
3. **Store Branding (Optional):** `PrepareSourceContext` defaults to `Sample Shop` and `Sample Shop Support`. Update these strings if desired.

---

## Step 5: Import the Sample Orders Sheet as Plain Text

Create a new Google Sheet with a tab named **`Orders`** and import [`database/sample-orders.csv`](../database/sample-orders.csv).

- **Columns (`A:F`):** `order_number`, `customer_email`, `status`, `item`, `tracking_number`, `estimated_delivery`
- **Replace Customer Email:** Update `customer_email` in all three rows (`1001`, `1002`, `1003`) to match your controlled customer sender address.
- **CRITICAL — Format All Columns as Plain Text:**
  - In Google Sheets CSV import, uncheck **"Convert text to numbers, dates, and formulas"**, or pre-format columns `A:F` as **Plain text** before pasting.
  - `ReadAllOrders` reads unformatted values (`UNFORMATTED_VALUE` / `SERIAL_NUMBER`) so that accidental numeric or date-serial conversions are caught and rejected by the validator.
  - Verify that `1001`, `1002`, and `1003` are stored as text strings, `2026-10-20` is a literal `YYYY-MM-DD` string, and empty optional cells (`tracking_number` and `estimated_delivery` on `1002`; `estimated_delivery` on `1003`) are genuinely blank (no spaces, `null` text, or formulas).

---

## Step 6: Create Gmail Labels & Rebind Resource Placeholders

### 1. Create the 3 Gmail Labels in the Receiver Account
Create these exact label names in the receiver's Gmail mailbox:
- `order-status-reply-drafter/demo-input`
- `order-status-reply-drafter/triaged`
- `order-status-reply-drafter/needs-review`

*(The Gmail Trigger search query already filters by these exact label names and excludes `triaged`, drafts, Spam, and Trash—do not put internal label IDs into the trigger search query string.)*

### 2. Look Up the Internal Gmail Label IDs (in a Blank Scratch Canvas)
Gmail REST API operations require internal IDs (e.g. `Label_1`), not label names. To safely look them up without dirtying `DraftOrderStatusReply` or incrementing its version:
1. Click **+ Add workflow** to open a blank scratch canvas.
2. Add a **Gmail** node:
   - **Credential:** Your authenticated receiver Gmail credential
   - **Resource:** `Label`
   - **Operation:** `Get Many`
3. Click **Execute step** to view the table of all Gmail labels and their IDs.
4. Note down the 3 matching IDs:
   - `order-status-reply-drafter/demo-input` → `<INPUT_LABEL_ID>` (e.g. `Label_1`)
   - `order-status-reply-drafter/triaged` → `<TRIAGED_LABEL_ID>` (e.g. `Label_2`)
   - `order-status-reply-drafter/needs-review` → `<REVIEW_LABEL_ID>` (e.g. `Label_3`)
5. Close and discard the scratch workflow.

### 3. Rebind Resource & Workflow Placeholders (6 Nodes Total)

All label IDs and email addresses inside `DraftOrderStatusReply` are centralized in the **`WorkflowConfig`** Edit Fields node (Phase `01`), Slack error alert channel configuration lives in **`ErrorAlertConfig`** inside `NotifyOrderStatusError`, recovery sweep settings live in **`SelectUnresolvedRequest`** inside `RecoverOrderStatusRequest`, `ReceivePendingDemo` already filters by `label:order-status-reply-drafter/demo-input` via its search query, and sub-workflow/sheet selections use n8n dropdowns—**no raw JavaScript expressions need to be edited**:

| Node | Workflow | Action |
| --- | --- | --- |
| **`ReadAllOrders`** | `GetOrder` | Select your Google Sheet (`<SPREADSHEET_ID>`) and the `Orders` tab (`<ORDERS_TAB_ID>`) from the dropdowns (keep range `A:F` and read all rows) |
| **`ErrorAlertConfig`** | `NotifyOrderStatusError` (Phase `01`) | Replace `slackChannelId` (`<SLACK_ERROR_CHANNEL_ID>`) with your Slack channel ID for `#order-status-drafter-alerts` |
| **`WorkflowConfig`** | `DraftOrderStatusReply` (Phase `01`) | Fill in the 5 form fields: `customerEmail`, `receiverEmail`, and the 3 internal Gmail IDs (`inputLabelId`, `triagedLabelId`, `reviewLabelId`—e.g. `Label_1`, `Label_2`, `Label_3` from step 2 above, **not** the label text names) |
| **`GetOrderDeterministically`** | `DraftOrderStatusReply` (Phase `04`) | Select the imported `GetOrder` workflow (`<GET_ORDER_WORKFLOW_ID>`) from the dropdown (keep string `order_number`, per-item mode, wait enabled, type conversion off) |
| **`SelectUnresolvedRequest`** | `RecoverOrderStatusRequest` | Replace `receiverEmail` (`controlled-receiver@example.com`) with your authenticated support receiver Gmail address (keep `cooldownSeconds: 300`, `batchLimit: 5`, `settleWindowMs: 60000`, and leave manual override fields blank/false) |
| **`RecoverThroughMain`** | `RecoverOrderStatusRequest` | Select the imported `DraftOrderStatusReply` workflow (`<MAIN_WORKFLOW_ID>`) from the dropdown |

---

## Step 7: Verify Model Settings, Publish Dependencies & Attach `Error Workflow`

### Accepted Model Configuration

| Stage & Provider | Model & Parameters |
| --- | --- |
| **Groq** (Extraction & Drafting) | `qwen/qwen3.8-27b`, `temperature: 0`, `maxTokensToSample: 1024` |
| **OpenRouter** (Extraction Fallback) | `openrouter/free`, `temperature: 0`, `maxTokens: 1024`, `timeout: 60000` ms, `maxRetries: 0` |
| **OpenRouter** (Drafting Fallback) | `openrouter/free`, `temperature: 0`, `maxTokens: 4096`, `timeout: 60000` ms, `maxRetries: 0` |

### Publish `GetOrder` & `NotifyOrderStatusError` First
In n8n, callable sub-workflows and error workflows must be published/activated before the parent workflows that reference them:
1. Open `GetOrder`, verify its Google Sheets binding, and **publish** it (`GetOrder` has no polling trigger of its own).
2. Open `NotifyOrderStatusError`, verify `ErrorAlertConfig` (`slackChannelId`) and `SendSlackErrorAlert` (`slackApi` credential), and **activate/publish** it before activating `DraftOrderStatusReply` or `RecoverOrderStatusRequest`.
3. Open `DraftOrderStatusReply`, verify all connections, bindings, and that **zero test pins** exist on any node, then open **Workflow Settings → Error Workflow** in the n8n UI and select **`NotifyOrderStatusError`**.
4. Open `RecoverOrderStatusRequest`, verify `SelectUnresolvedRequest` (`receiverEmail`), `FindRecoverableRequests` (`OrderStatusLedger` Postgres credential), and `RecoverThroughMain` (`DraftOrderStatusReply`), then open **Workflow Settings → Error Workflow** in the n8n UI and select **`NotifyOrderStatusError`**.

---

## Step 8: Supervised Smoke Test & Operation

1. **Ensure `NotifyOrderStatusError` is active**, then **activate `DraftOrderStatusReply`** (and optionally **`RecoverOrderStatusRequest`** for 5-minute automated recovery sweeps) only when you are ready to observe them. Note that `DraftOrderStatusReply` must be published before `RecoverOrderStatusRequest` can invoke it via `RecoverThroughMain`.
2. Send a fresh plain-text email from your controlled sender account to the receiver account (e.g., *"Where is order 1001?"*) and apply the `order-status-reply-drafter/demo-input` label on arrival.
3. Wait for the 1-minute poll trigger to run and verify:
   - A reply draft is created inside the original Gmail thread (not sent).
   - The source message receives the `order-status-reply-drafter/triaged` label.
   - The PostgreSQL ledger row reaches `phase = 'Completed'` and `status = 'Completed'`.
4. **Inspect every draft** before manually sending.
5. **Deactivate/unpublish `DraftOrderStatusReply` and `RecoverOrderStatusRequest`** when finished with supervised testing.
   - *Never remove the `triaged` label or delete ledger rows to replay a message.* For details on automated 5-minute sweeps and manual `NeedsInspection` recovery overrides, follow the [Operator Recovery Guide](order-status-recovery-guide.md).

---

## Optional Testing Suites

- **Offline Policy, Model Evaluation & End-to-End Regression:** See [`docs/testing-guide.md`](testing-guide.md).
