# Live End-to-End Regression & Demo Runner

This directory contains the optional end-to-end test orchestrator (`RunOrderStatusRegressionTest`), evidence observer (`ObserveOrderStatusCase`), and fixture sender (`Sender`). Together, they test the real `DraftOrderStatusReply` workflow end-to-end across Gmail, Google Sheets, PostgreSQL, and Groq/OpenRouter.

For scenario pass criteria (`S01`–`S10`), see [`../../../docs/demo-test-cases.md`](../../../docs/demo-test-cases.md). For recorded verification results, see [`../../reliability/verification-results.json`](../../reliability/verification-results.json).

---

## 1. Execution Modes

Before clicking **Execute workflow** on `RunOrderStatusRegressionTest`, set `mode` in the **`RunConfiguration`** node:

| `mode` | Scenarios Run | Controlled Emails Sent | Expected Outcomes |
| --- | --- | --- | --- |
| **`regression`** *(default)* | All 10 cases (`S01`–`S10`) | 9 customer SMTP + 1 receiver-to-self Gmail | 6 reply drafts + 4 manual reviews |
| **`demo`** | 4 representative cases (`S01`, `S04`, `S06`, `S08`) | 3 customer SMTP + 1 receiver-to-self Gmail | 2 reply drafts + 2 manual reviews |

- Both modes run the exact same observer assertions per case, verify PostgreSQL ledger ownership and checkpoint ordering, and restore the main workflow's initial active/inactive state when finished.
- `demo` mode exercises a 4-case subset and does not report a full 10-case `regression` PASS.

---

## 2. One-Time Setup & Rebinding

Complete standard application setup ([`../../../docs/setup-and-rebinding.md`](../../../docs/setup-and-rebinding.md)) and publish `GetOrder` before configuring the end-to-end runner.

### Step 1: Import the 3 E2E Workflows (Inactive)
Import the following files inactive:
1. [`sender-callable.json`](sender-callable.json) (`Sender`)
2. [`observe-order-status-case.json`](observe-order-status-case.json) (`ObserveOrderStatusCase`)
3. [`run-order-status-regression.json`](run-order-status-regression.json) (`RunOrderStatusRegressionTest`)

### Step 2: Configure `Sender`
- `Sender` accepts typed inputs (`subject`, `body`, `senderMode`: `"customer"` or `"self"`).
- Replace `<CUSTOMER_EMAIL>` and `<RECEIVER_EMAIL>` with your controlled customer and receiver email addresses.
- Bind your **SMTP credential** for the controlled customer account on the customer send path, and your **Gmail OAuth2 credential** for the controlled receiver account on the `self` send path.

### Step 3: Bind Credentials in Runner & Observer
1. **n8n API (`OrderStatusRegressionApi`):** Bind an n8n API credential pointing to your instance's `/api/v1` base URL on all n8n API nodes in both `RunOrderStatusRegressionTest` and `ObserveOrderStatusCase`.
   - Required permissions (if using scoped API keys): `workflow:read`, `workflow:activate`, `workflow:deactivate`, `execution:read`, `execution:list`.
2. **Gmail OAuth2:** Bind the receiver's Gmail credential on all Gmail nodes in the runner and observer.
3. **Google Sheets OAuth2:** Bind the runner's read-only Sheets check to the same `Orders` spreadsheet/tab used by `GetOrder`, and replace `<ORDERS_SPREADSHEET_ID>`, `<ORDERS_SHEET_GID>`, and `<RECEIVER_GMAIL_CREDENTIAL_ID>` in **`CheckReadiness`**.

### Step 4: Create the `OrderStatusRegressionSessions` Data Table
Create a dedicated n8n **Data Table** named **`OrderStatusRegressionSessions`** with these user-defined columns:
- `sessionId` (String)
- `active` (Boolean)
- `status` (String)
- `state_object` (String — stores serialized JSON)
- `summary_object` (String — stores serialized JSON)
*(Do not manually declare system `id`, `createdAt`, or `updatedAt` columns.)*

Rebind `<SESSION_DATA_TABLE_ID>` on all Data Table nodes in `RunOrderStatusRegressionTest`.

### Step 5: Publish Callable Helpers & Link Workflow IDs
1. Validate and **publish** both `Sender` and `ObserveOrderStatusCase` (neither has a polling or public trigger).
2. In `RunOrderStatusRegressionTest`, replace `<OBSERVER_WORKFLOW_ID>`, `<SENDER_WORKFLOW_ID>`, `<MAIN_WORKFLOW_ID>`, and `<GET_ORDER_WORKFLOW_ID>`.

### Step 6: Create the Gmail Arrival Filter in the Receiver Account
In the receiver's Gmail settings, create a filter so test emails receive the intake label automatically upon arrival:
- **From:** `<CUSTOMER_EMAIL> OR <RECEIVER_EMAIL>`
- **To:** `<RECEIVER_EMAIL>`
- **Subject:** `OSRD SMOKE`
- **Has the words:** *(leave empty)*
- **Action:** Apply label `order-status-reply-drafter/demo-input` (do **not** apply retroactively to existing conversations, and ensure test messages are not routed to Spam).

### Step 7: Finalize `RunConfiguration`
In `RunOrderStatusRegressionTest` → **`RunConfiguration`**:
1. Set `<VALIDATED_MAIN_VERSION>`, `<VALIDATED_GET_ORDER_VERSION>`, `<VERIFIED_SENDER_VERSION>`, and the main workflow's `ledgerCandidate` fingerprint.
2. Confirm that `DraftOrderStatusReply` has zero node test pins.
3. Set `arrivalFilterConfirmed: true`, `apiCredentialReady: true`, and `runEnabled: true` (exported as `false` by default for safety).

---

## 3. Running the Suite & Updating After Edits

1. Open **`RunOrderStatusRegressionTest`** and click **Execute workflow** once (keep the runner workflow itself inactive/manual).
2. The runner verifies readiness, acquires a session lock in `OrderStatusRegressionSessions`, temporarily activates the selected version of `DraftOrderStatusReply` (if starting inactive), dispatches each fixture email with a fresh alphabetic `OSRD SMOKE ...` subject, polls `ObserveOrderStatusCase` for completion, and restores `DraftOrderStatusReply` to its starting state.
3. Inspect the final **`SuiteResults`** node output and the session summary in `OrderStatusRegressionSessions`.

**After editing `DraftOrderStatusReply` or `GetOrder`:**
Validate and read back the updated workflow, publish the updated child if changed, update `mainVersion` / `childVersion` / `ledgerCandidate` in `RunConfiguration`, and run `RunOrderStatusRegressionTest` once.

---

## 4. Timing, Timeouts & Cleanup

- **Initialization & Polling:** The runner allows 80 seconds for the 1-minute Gmail trigger to initialize, then polls `ObserveOrderStatusCase` every 20 seconds for up to **10 minutes per case**.
- **Session Budget:** A 50-minute session budget (within a 1-hour workflow ceiling) stops dispatching new emails unless at least 15 minutes remain for observation and workflow state restoration. Unsent cases are reported as `NOT_RUN`.
- **No Automatic Resends:** The runner records dispatch intent before sending each email and never automatically resends on a delivery timeout.
- **Manual Cleanup After a Runner Crash:** If the n8n host crashes mid-run, `DraftOrderStatusReply` may remain active and the session row in `OrderStatusRegressionSessions` may remain `active: true` (blocking future runs). To clean up:
  1. Open **`DraftOrderStatusReply`** and **deactivate/unpublish** it.
  2. Inspect the active row in `OrderStatusRegressionSessions` and any in-flight Gmail source/draft or PostgreSQL ledger record.
  3. Mark the session row inactive only after reconciling the interrupted run.
