# Destination Rebinding Checklist

All exported workflows in this package are **inactive** and stripped of credentials and environment-specific IDs. Before activating or running any workflow, bind your destination credentials and replace every placeholder listed below.

Use this checklist alongside:
- [Setup and Rebinding Guide](setup-and-rebinding.md)
- [Ledger Database Setup](ledger-database-setup.md)
- [End-to-End Regression Guide](testing-guide.md) (for optional test workflows)

---

## 1. Workflow Placeholders by File

### Core Application Workflows

| Workflow | Export Path | Nodes to Configure | Placeholders / Fields |
| --- | --- | --- | --- |
| **GetOrder** | `workflows/get-order.json` | `ReadAllOrders` (dropdowns) | `<SPREADSHEET_ID>`, `<ORDERS_TAB_ID>` |
| **DraftOrderStatusReply** (Main) | `workflows/main-workflow.json` | `WorkflowConfig` (5 form fields), `GetOrderDeterministically` (dropdown) | `customerEmail`, `receiverEmail`, `<INPUT_LABEL_ID>`, `<TRIAGED_LABEL_ID>`, `<REVIEW_LABEL_ID>`, `<GET_ORDER_WORKFLOW_ID>` |
| **RecoverOrderStatusRequest** | `workflows/recover-order-status-request.json` | `RecoverThroughMain` (dropdown) | `<MAIN_WORKFLOW_ID>` |

### Optional Testing & Evaluation Workflows

| Workflow | Export Path | Nodes to Configure | Placeholders to Replace |
| --- | --- | --- | --- |
| **EvaluateOrderStatusModels** | `workflows/harness/evaluation-workflow.json` | `EvaluateModelCases`, `RecordModelOutputs`, `RecordCaseById` (dropdowns) | `<MODEL_TEST_DATA_TABLE_ID>` |
| **Sender** | `workflows/harness/sender-callable.json` | `SenderConfig` (2 form fields) | `<CUSTOMER_EMAIL>`, `<RECEIVER_EMAIL>` |
| **ObserveOrderStatusRegressionCase** | `workflows/harness/observe-order-status-case.json` | *(0 placeholder nodes)* | Bind destination Gmail and n8n API credentials on all nodes |
| **RunOrderStatusRegressionTest** | `workflows/harness/run-order-status-regression.json` | `RunConfiguration` ([field reference](testing-guide.md#runconfiguration-field-by-field-reference)) | `<CUSTOMER_EMAIL>`, `<RECEIVER_EMAIL>`, `<RECEIVER_GMAIL_CREDENTIAL_ID>`, `<ORDERS_SPREADSHEET_ID>`, `<ORDERS_SHEET_GID>`, `<MAIN_WORKFLOW_ID>`, `<GET_ORDER_WORKFLOW_ID>`, `<OBSERVER_WORKFLOW_ID>`, `<SENDER_WORKFLOW_ID>`, `<SESSION_DATA_TABLE_ID>`, `<VALIDATED_MAIN_VERSION>`, `<VALIDATED_GET_ORDER_VERSION>`, `<VERIFIED_SENDER_VERSION>` |

---

## 2. Reserved Email Addresses & Sample Data

Replace all placeholder email addresses in `WorkflowConfig` and your Google Sheet:

- **`controlled-sender@example.com` / `<CUSTOMER_EMAIL>`** → Replace with your controlled customer test email in:
  - `WorkflowConfig` (`customerEmail` field) in `workflows/main-workflow.json`
  - All `customer_email` rows in `database/sample-orders.csv` (before or after importing to Google Sheets)
  - `Sender` and `RunOrderStatusRegressionTest` (if using the end-to-end runner)
- **`controlled-receiver@example.com` / `<RECEIVER_EMAIL>`** → Replace with your authenticated support receiver Gmail address in:
  - `WorkflowConfig` (`receiverEmail` field) in `workflows/main-workflow.json` (used for both receiver mailbox verification and the allowlists supporting the receiver-to-self sender-mismatch test case `S08`)
  - `Sender` and `RunOrderStatusRegressionTest` (if using the end-to-end runner)

---

## 3. Credential Bindings

Every credentialed node must be explicitly bound and verified in n8n (do not rely on default credential auto-selection):

- **Gmail OAuth2 (`gmailOAuth2`):** All Gmail trigger, message read, draft create/get, and label nodes—**plus** the `ReadMailboxIdentity` HTTP Request node (uses predefined Gmail OAuth2 credential).
- **Postgres (`postgres`):** Bind `OrderStatusLedger` on all Postgres ledger nodes in `DraftOrderStatusReply`.
- **Google Sheets OAuth2 (`googleSheetsOAuth2Api`):** `ReadAllOrders` in `GetOrder` (and the readiness check in the optional regression runner).
- **Groq API (`groqApi`):** Both `GroqExtractionModel` and `GroqDraftingModel` subnodes (and in `EvaluateOrderStatusModels` if running model evals).
- **OpenRouter API (`openRouterApi`):** Both `OpenRouterExtractionModel` and `OpenRouterDraftingModel` subnodes.
- **n8n API (`n8nApi`):** `ReadPreviousExecution` in `DraftOrderStatusReply` (and all n8n API nodes in the optional runner/observer).

---

## 4. Safety & Readiness Flags

- **Centralized label & email config:** When setting `customerEmail`, `receiverEmail`, `inputLabelId`, `triagedLabelId`, and `reviewLabelId` in `WorkflowConfig`, all downstream label and allowlist nodes (`VerifyMailboxAndSource`, `ValidateRequestInput`, `RecheckAllowedRecipient`, `ConfirmSavedDraft`, `MarkConfirmedDraftTriaged`, `ApplyReviewAndTriagedLabels`, and `VerifyFinalSourceLabels`) read from `WorkflowConfig` automatically. *(Note: `inputLabelId`, `triagedLabelId`, and `reviewLabelId` must be the internal Gmail IDs such as `Label_1`, `Label_2`, `Label_3`—not the human-readable path strings; see Setup Guide Step 6.2).*
- **Keep safety gates closed until ready:**
  - In `RecoverOrderStatusRequest`, leave `writesSettled: false` and identifiers blank until you are actively recovering a specific inspected request.
  - In `RunOrderStatusRegressionTest`, leave `arrivalFilterConfirmed`, `apiCredentialReady`, and `runEnabled` set to `false` until all E2E setup steps are verified.
