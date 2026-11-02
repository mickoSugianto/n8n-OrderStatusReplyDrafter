# Testing, Model Evaluation & End-to-End Regression Guide

This guide covers all three verification tiers for the Order-Status Reply Drafter:
1. **Offline Policy, Recovery & Source-Linkage Verification** (local Node.js, zero external calls)
2. **Native Model-Stage Evaluation** (`workflows/harness/evaluation-workflow.json`)
3. **Live End-to-End Regression & Demo Runner** (`workflows/harness/run-order-status-regression.json`)

For scenario pass criteria (`S01`–`S10`), see [`demo-test-cases.md`](demo-test-cases.md). For system architecture and boundaries, see [`system-design.md`](system-design.md).

---

## 1. Offline Policy, Recovery & Source-Linkage Checks

Requires Node.js (built-in modules only; zero network calls, credentials, or external services). Run from the repository root:

```sh
npm test
```

Or run each suite individually:

```sh
node tests/run-regression.js
node tests/check-recovery.js
node tests/check-source-linkage.js workflows/main-workflow.json workflows/get-order.json
```

- `tests/run-regression.js` executes **246 deterministic unit/policy cases** (78 order-validator cases + 168 intake/extraction/lookup/draft/save/error-classification cases) and **3 static audits**.
- `tests/check-recovery.js` executes **57 focused offline recovery, guard, and snapshot checks**.
- `tests/check-source-linkage.js` verifies that **15 inline runtime expressions** and **both model stage prompts/schemas/settings** inside `workflows/main-workflow.json` and `workflows/get-order.json` match the shared policy libraries in `src/`.

### Key Source & Test Files

| File | Purpose |
| --- | --- |
| `src/main-policy.js` & `src/validate-order.js` | Shared deterministic policy and order-validation functions |
| `src/recovery-policy.js` | Recovery decision helpers and ownership guard logic |
| `src/source-linkage.json` & `src/model-definitions.json` | Expected expression hashes and model prompt/schema/parameter baselines |
| `tests/fixtures/policy-cases.json` & `tests/fixtures/order-fixtures.js` | Independent test fixtures for the 246 policy/validator cases |
| `tests/fixtures/evaluation-cases.json` & `tests/fixtures/dataset-rows.js` | Model-stage evaluation cases and CSV dataset generator |
| `tests/fixtures/e2e-cases.json` | End-to-end scenario definitions (`S01`–`S10`) |

---

## 2. Reconstructing the Native Model Evaluation in n8n

To evaluate the LLM extraction and drafting stages directly inside n8n (without running Gmail or Google Sheets):

### Step 1: Import the Evaluation Workflow
Import [`../workflows/harness/evaluation-workflow.json`](../workflows/harness/evaluation-workflow.json) (`EvaluateOrderStatusModels`) into n8n and keep it **inactive/unpublished**. It contains 12 nodes, a stage selector (`extraction` vs. `drafting`), and no production Gmail or Sheets nodes.

### Step 2: Create the Evaluation Data Table
Create a dedicated n8n **Data Table** (do **not** reuse `Orders`) with the following columns:
- **String columns:** `caseId`, `stage`, `provider`, `model`, `source_object`, `case_object`, `expected_object`, `actual_object`, `metrics_object`, `error`, `run_object`
- **Boolean column:** `pass` (initially `null`)
- *(n8n automatically provides system `id`, `createdAt`, and `updatedAt` columns.)*

### Step 3: Generate and Import the 8 Dataset Rows
From the repository root, generate the CSV rows locally:

```sh
node tests/fixtures/dataset-rows.js > model-evaluation-rows.csv
```

Import the 8 generated rows into your evaluation Data Table using the column types above.

### Step 4: Rebind Table & Credentials
1. Replace `<MODEL_TEST_DATA_TABLE_ID>` in **`EvaluateModelCases`**, **`RecordModelOutputs`**, and **`RecordCaseById`** with your evaluation Data Table ID.
2. Bind your **Groq API** credential on both Groq model subnodes (`qwen/qwen3.8-27b`).

### Step 5: Execute the Evaluation
1. In the n8n editor, filter **`EvaluateModelCases`** to 1 representative case (`maxRows: 1`) and run a single test first to verify credential and table bindings.
2. Filter out the completed first case, set `maxRows: 7`, and click **Evaluate all** once to run the remaining 7 cases.
3. Restore `EvaluateModelCases` to filtering off and `maxRows: 8` when finished, and keep the workflow inactive.

---

## 3. Live End-to-End Regression & Demo Runner

The optional end-to-end test orchestrator (`RunOrderStatusRegressionTest`), evidence observer (`ObserveOrderStatusCase`), and fixture sender (`Sender`) test the real `DraftOrderStatusReply` workflow end-to-end across Gmail, Google Sheets, PostgreSQL, and Groq/OpenRouter.

### Execution Modes

Before clicking **Execute workflow** on `RunOrderStatusRegressionTest`, set `mode` in the **`RunConfiguration`** node:

| `mode` | Scenarios Run | Controlled Emails Sent | Expected Outcomes |
| --- | --- | --- | --- |
| **`regression`** *(default)* | All 10 cases (`S01`–`S10`) | 9 customer SMTP + 1 receiver-to-self Gmail | 6 reply drafts + 4 manual reviews |
| **`demo`** | 4 representative cases (`S01`, `S04`, `S06`, `S08`) | 3 customer SMTP + 1 receiver-to-self Gmail | 2 reply drafts + 2 manual reviews |

### Setup & Rebinding for E2E Harness Workflows

1. **Import the 3 E2E Harness Workflows (Inactive):**
   - [`../workflows/harness/sender-callable.json`](../workflows/harness/sender-callable.json) (`Sender`)
   - [`../workflows/harness/observe-order-status-case.json`](../workflows/harness/observe-order-status-case.json) (`ObserveOrderStatusCase`)
   - [`../workflows/harness/run-order-status-regression.json`](../workflows/harness/run-order-status-regression.json) (`RunOrderStatusRegressionTest`)
2. **Configure `Sender`:** Replace `<CUSTOMER_EMAIL>` and `<RECEIVER_EMAIL>`, bind your **SMTP credential** for the customer path, and bind your **Gmail OAuth2 credential** for the `self` path.
3. **Bind Credentials in Runner & Observer:** Bind your **n8n API** credential (`OrderStatusRegressionApi`), receiver **Gmail OAuth2** credential, and **Google Sheets OAuth2** credential.
4. **Create the `OrderStatusRegressionSessions` Data Table:** Create a dedicated n8n Data Table with columns `sessionId` (String), `active` (Boolean), `status` (String), `state_object` (String), and `summary_object` (String), and rebind `<SESSION_DATA_TABLE_ID>`.
5. **Publish Callable Helpers & Link Workflow IDs:** Validate and publish `Sender` and `ObserveOrderStatusCase`, then replace `<OBSERVER_WORKFLOW_ID>`, `<SENDER_WORKFLOW_ID>`, `<MAIN_WORKFLOW_ID>`, and `<GET_ORDER_WORKFLOW_ID>` in `RunOrderStatusRegressionTest`.
6. **Create the Gmail Arrival Filter:** In the receiver's Gmail settings, create a filter matching `From: <CUSTOMER_EMAIL> OR <RECEIVER_EMAIL>`, `To: <RECEIVER_EMAIL>`, and `Subject: OSRD SMOKE` that applies `order-status-reply-drafter/demo-input`.
7. **Finalize `RunConfiguration` & Execute:** Set the validated version IDs and `ledgerCandidate` fingerprint, confirm zero test pins on `DraftOrderStatusReply`, set `arrivalFilterConfirmed: true`, `apiCredentialReady: true`, and `runEnabled: true`, and click **Execute workflow** once.
