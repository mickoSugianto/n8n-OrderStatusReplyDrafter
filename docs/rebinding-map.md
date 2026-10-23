# Destination Rebinding Checklist

All exported workflows in this package are **inactive** and stripped of credentials and environment-specific IDs. Before activating or running any workflow, bind your destination credentials and replace every placeholder listed below.

Use this checklist alongside:
- [Setup and Rebinding Guide](setup-and-rebinding.md)
- [Ledger Database Setup](ledger-database-setup.md)
- [End-to-End Regression Guide](../deliverables/regression/end-to-end/README.md) (for optional test workflows)

---

## 1. Workflow Placeholders by File

### Core Application Workflows

| Workflow | Export Path | Placeholders to Replace |
| --- | --- | --- |
| **GetOrder** | `deliverables/get-order.json` | `<SPREADSHEET_ID>`, `<ORDERS_TAB_ID>` |
| **DraftOrderStatusReply** (Main) | `deliverables/main-workflow.json` | `<GET_ORDER_WORKFLOW_ID>`, `<MAIN_WORKFLOW_ID>`, `<INPUT_LABEL_ID>`, `<TRIAGED_LABEL_ID>`, `<REVIEW_LABEL_ID>` |
| **RecoverOrderStatusRequest** | `deliverables/reliability/recover-order-status-request.json` | `<MAIN_WORKFLOW_ID>` |

### Optional Testing & Evaluation Workflows

| Workflow | Export Path | Placeholders to Replace |
| --- | --- | --- |
| **EvaluateOrderStatusModels** | `deliverables/regression/evaluation-workflow.json` | `<MODEL_TEST_DATA_TABLE_ID>` |
| **Sender** | `deliverables/regression/end-to-end/sender-callable.json` | `<CUSTOMER_EMAIL>`, `<RECEIVER_EMAIL>` |
| **ObserveOrderStatusRegressionCase** | `deliverables/regression/end-to-end/observe-order-status-case.json` | Bind destination Gmail and n8n API credentials on all nodes |
| **RunOrderStatusRegressionTest** | `deliverables/regression/end-to-end/run-order-status-regression.json` | `<CUSTOMER_EMAIL>`, `<RECEIVER_EMAIL>`, `<RECEIVER_GMAIL_CREDENTIAL_ID>`, `<ORDERS_SPREADSHEET_ID>`, `<ORDERS_SHEET_GID>`, `<MAIN_WORKFLOW_ID>`, `<GET_ORDER_WORKFLOW_ID>`, `<OBSERVER_WORKFLOW_ID>`, `<SENDER_WORKFLOW_ID>`, `<SESSION_DATA_TABLE_ID>`, `<VALIDATED_MAIN_VERSION>`, `<VALIDATED_GET_ORDER_VERSION>`, `<VERIFIED_SENDER_VERSION>` |

---

## 2. Reserved Email Addresses & Sample Data

Replace all placeholder email addresses across workflow code expressions and your Google Sheet:

- **`controlled-sender@example.com` / `<CUSTOMER_EMAIL>`** → Replace with your controlled customer test email in:
  - `ValidateRequestInput` and `RecheckAllowedRecipient` allowlists in `deliverables/main-workflow.json`
  - All `customer_email` rows in `deliverables/sample-orders.csv` (before or after importing to Google Sheets)
  - `Sender` and `RunOrderStatusRegressionTest` (if using the end-to-end runner)
- **`controlled-receiver@example.com` / `<RECEIVER_EMAIL>`** → Replace with your authenticated support receiver Gmail address in:
  - `VerifyMailboxAndSource` expected receiver check in `deliverables/main-workflow.json`
  - `ValidateRequestInput` and `RecheckAllowedRecipient` allowlists in `deliverables/main-workflow.json` (kept in the allowlist to support the receiver-to-self sender-mismatch test case `S08`)
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

- **Label IDs in expressions:** When replacing `<INPUT_LABEL_ID>`, `<TRIAGED_LABEL_ID>`, and `<REVIEW_LABEL_ID>`, update both the Gmail node parameters and the label-verification code expressions (`VerifyMailboxAndSource`, `VerifySourceLabels`).
- **Keep safety gates closed until ready:**
  - In `RecoverOrderStatusRequest`, leave `writesSettled: false` and identifiers blank until you are actively recovering a specific inspected request.
  - In `RunOrderStatusRegressionTest`, leave `arrivalFilterConfirmed`, `apiCredentialReady`, and `runEnabled` set to `false` until all E2E setup steps are verified.
