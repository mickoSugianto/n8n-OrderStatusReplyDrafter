# Setup and Rebinding Guide

This guide covers step-by-step installation, credential binding, Google Sheets setup, and initial verification for the Order-Status Reply Drafter.

For system architecture and data contracts, see [As-Built System Design](system-design.md). For a quick lookup of all `<...>` placeholders, see [Destination Rebinding Checklist](rebinding-map.md).

---

## Step 1: Set Up the Ledger Database

Before importing workflows, provision the PostgreSQL ledger in Supabase by following [Ledger Database Setup](ledger-database-setup.md) and running [`database/order-status-ledger.sql`](../database/order-status-ledger.sql).

---

## Step 2: Import the Core Workflows (Inactive)

Import the following three workflow exports into n8n and keep them **inactive** during configuration:
1. [`deliverables/get-order.json`](../deliverables/get-order.json) (`GetOrder`)
2. [`deliverables/main-workflow.json`](../deliverables/main-workflow.json) (`DraftOrderStatusReply`)
3. [`deliverables/reliability/recover-order-status-request.json`](../deliverables/reliability/recover-order-status-request.json) (`RecoverOrderStatusRequest`)

---

## Step 3: Create and Bind Credentials

Create or select credentials in n8n and explicitly verify the bound account on **every** credentialed node (including all four LLM subnodes and the HTTP Request profile node). Never hardcode API keys or secrets in node expressions.

| Credential Type | Nodes to Bind |
| --- | --- |
| **Gmail OAuth2 API** (`gmailOAuth2`) | All Gmail trigger, message read, draft create/read, and label nodes in `DraftOrderStatusReply`, plus the `ReadMailboxIdentity` HTTP Request node |
| **Postgres** (`postgres`) | All ledger nodes in `DraftOrderStatusReply` (use the restricted `OrderStatusLedger` credential with SSL enabled) |
| **n8n API** (`n8nApi`) | `ReadPreviousExecution` in `DraftOrderStatusReply` (pointed to your destination instance `/api/v1` URL for recovery checks) |
| **Google Sheets OAuth2 API** (`googleSheetsOAuth2Api`) | `ReadAllOrders` in `GetOrder` |
| **Groq API** (`groqApi`) | `GroqExtractionModel` and `GroqDraftingModel` subnodes |
| **OpenRouter API** (`openRouterApi`) | `OpenRouterExtractionModel` and `OpenRouterDraftingModel` subnodes |

*Note: Ensure Google Drive API is enabled in your Google Cloud project if n8n requires it for spreadsheet resource discovery.*

---

## Step 4: Configure Controlled Accounts & Allowlists

The demonstration design uses **two controlled email accounts**:
- **Customer sender account** (sends test order inquiries)
- **Support receiver account** (the Gmail inbox watched by n8n)

Update the following account references in `DraftOrderStatusReply`:
1. **`VerifyMailboxAndSource`:** Replace `controlled-receiver@example.com` with your authenticated receiver Gmail address.
2. **`ValidateRequestInput` & `RecheckAllowedRecipient`:** In **both** nodes, replace `controlled-sender@example.com` with your controlled sender email and `controlled-receiver@example.com` with your receiver email.
   - *Keep both addresses in both allowlists.* Allowing the receiver address to send an email to itself enables the sender-ownership mismatch test scenario (`S08`).
3. **Store Branding (Optional):** `PrepareSourceContext` defaults to `Sample Shop` and `Sample Shop Support`. Update these strings if desired.

---

## Step 5: Import the Sample Orders Sheet as Plain Text

Create a new Google Sheet with a tab named **`Orders`** and import [`deliverables/sample-orders.csv`](../deliverables/sample-orders.csv).

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

### 2. Replace Resource & Workflow Placeholders

| Placeholder | Location | Action |
| --- | --- | --- |
| `<SPREADSHEET_ID>` | `GetOrder` → `ReadAllOrders` → `documentId` | Select your Google Sheet |
| `<ORDERS_TAB_ID>` | `GetOrder` → `ReadAllOrders` → `sheetName` | Select the `Orders` tab (keep range `A:F` and read all rows) |
| `<GET_ORDER_WORKFLOW_ID>` | `DraftOrderStatusReply` → `GetOrderDeterministically` | Select the imported `GetOrder` workflow (keep string `order_number`, per-item mode, wait enabled, type conversion off) |
| `<MAIN_WORKFLOW_ID>` | `DraftOrderStatusReply` (previous-execution check) & `RecoverOrderStatusRequest` (`RecoverThroughMain`) | Set to the destination workflow ID of `DraftOrderStatusReply` |
| `<INPUT_LABEL_ID>` | `ReceivePendingDemo` (`filters.labelIds`) & `VerifyMailboxAndSource` | Set to the receiver's `order-status-reply-drafter/demo-input` label ID |
| `<TRIAGED_LABEL_ID>` | `MarkConfirmedDraftTriaged`, `ApplyReviewAndTriagedLabels`, & `VerifySourceLabels` | Set to the receiver's `order-status-reply-drafter/triaged` label ID |
| `<REVIEW_LABEL_ID>` | `ApplyReviewAndTriagedLabels` & `VerifySourceLabels` | Set to the receiver's `order-status-reply-drafter/needs-review` label ID |

---

## Step 7: Verify Model Settings & Publish `GetOrder`

### Accepted Model Configuration

| Stage & Provider | Model & Parameters |
| --- | --- |
| **Groq** (Extraction & Drafting) | `qwen/qwen3.8-27b`, `temperature: 0`, `maxTokensToSample: 1024` |
| **OpenRouter** (Extraction Fallback) | `openrouter/free`, `temperature: 0`, `maxTokens: 1024`, `timeout: 60000` ms, `maxRetries: 0` |
| **OpenRouter** (Drafting Fallback) | `openrouter/free`, `temperature: 0`, `maxTokens: 4096`, `timeout: 60000` ms, `maxRetries: 0` |

### Publish `GetOrder` First
In n8n, callable sub-workflows must be published before the parent workflow can be published/activated:
1. Open `GetOrder`, verify its Google Sheets binding, and **publish** it (`GetOrder` has no polling trigger of its own).
2. Open `DraftOrderStatusReply`, verify all connections, bindings, and that **zero test pins** exist on any node.

---

## Step 8: Supervised Smoke Test & Operation

1. **Activate `DraftOrderStatusReply`** only when you are ready to observe it.
2. Send a fresh plain-text email from your controlled sender account to the receiver account (e.g., *"Where is order 1001?"*) and apply the `order-status-reply-drafter/demo-input` label on arrival.
3. Wait for the 1-minute poll trigger to run and verify:
   - A reply draft is created inside the original Gmail thread (not sent).
   - The source message receives the `order-status-reply-drafter/triaged` label.
   - The PostgreSQL ledger row reaches `phase = 'Completed'` and `status = 'Completed'`.
4. **Inspect every draft** before manually sending.
5. **Deactivate/unpublish `DraftOrderStatusReply`** when finished with supervised testing.
   - *Never remove the `triaged` label or delete ledger rows to replay a message.* If an execution fails mid-flight, follow the [Operator Recovery Guide](order-status-recovery-guide.md).

---

## Optional Testing Suites

- **Offline Policy & Native Model Evaluation:** See [`deliverables/regression/README.md`](../deliverables/regression/README.md).
- **Live End-to-End Regression & Demo Runner:** See [`deliverables/regression/end-to-end/README.md`](../deliverables/regression/end-to-end/README.md).
