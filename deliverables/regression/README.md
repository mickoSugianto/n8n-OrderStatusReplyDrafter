# Policy Test Suite & Native Model Evaluation

This directory contains the offline policy/validator test suite, source-linkage audit scripts, and the native n8n model-stage evaluation workflow.

For full end-to-end testing against a live n8n instance, see [`end-to-end/README.md`](end-to-end/README.md). For system architecture and boundaries, see [`../../docs/system-design.md`](../../docs/system-design.md).

---

## 1. Offline Policy & Source-Linkage Checks

Requires Node.js (built-in modules only; zero network calls, credentials, or external services).

### Run the Policy & Validator Suite
From `deliverables/regression/` (or from the handoff root):

```sh
node deliverables/regression/run-regression.js
```

- Executes **246 deterministic unit/policy cases** (78 order-validator cases + 168 intake/extraction/lookup/draft/save/error-classification cases) and **3 static audits**.
- Exits non-zero if any assertion fails.

### Run the Source-Linkage Audit
From the handoff root directory, verify that the inline JavaScript expressions and model prompts/schemas inside your workflow JSON exports match the shared policy libraries:

```sh
node tests/check-source-linkage.js deliverables/main-workflow.json deliverables/get-order.json
```

### Run the Offline Recovery & Guard Suite
From the handoff root directory:

```sh
node tests/check-recovery.js
```

- Executes **57 focused offline recovery, guard, and snapshot checks**.

### Key Offline Files

| File | Purpose |
| --- | --- |
| `lib/main-policy.js` & `lib/validate-order.js` | Shared deterministic policy and order-validation functions |
| `lib/recovery-policy.js` & `lib/score-model.js` | Recovery decision helpers and model output scoring logic |
| `policy-cases.json` & `lib/order-fixtures.js` | Independent test fixtures for the 246 policy/validator cases |
| `source-linkage.json` & `model-definitions.json` | Expected expression hashes and model prompt/schema/parameter baselines |
| `verification-results.json` | Recorded offline and model-evaluation verification results |

---

## 2. Reconstructing the Native Model Evaluation in n8n

To evaluate the LLM extraction and drafting stages directly inside n8n (without running Gmail or Google Sheets):

### Step 1: Import the Evaluation Workflow
Import [`evaluation-workflow.json`](evaluation-workflow.json) (`EvaluateOrderStatusModels`) into n8n and keep it **inactive/unpublished**. It contains 12 nodes, a stage selector (`extraction` vs. `drafting`), and no production Gmail or Sheets nodes.

### Step 2: Create the Evaluation Data Table
Create a dedicated n8n **Data Table** (do **not** reuse `Orders`) with the following columns:
- **String columns:** `caseId`, `stage`, `provider`, `model`, `source_object`, `case_object`, `expected_object`, `actual_object`, `metrics_object`, `error`, `run_object`
- **Boolean column:** `pass` (initially `null`)
- *(n8n automatically provides system `id`, `createdAt`, and `updatedAt` columns.)*

### Step 3: Generate and Import the 8 Dataset Rows
From `deliverables/regression/`, generate the CSV rows locally:

```sh
node dataset-rows.js > model-evaluation-rows.csv
```

Import the 8 generated rows into your evaluation Data Table using the column types above.

### Step 4: Rebind Table & Credentials
1. Replace `<MODEL_TEST_DATA_TABLE_ID>` in **`EvaluateModelCases`**, **`RecordModelOutputs`**, and **`RecordCaseById`** with your evaluation Data Table ID.
2. Bind your **Groq API** credential on both Groq model subnodes (`qwen/qwen3.8-27b`).

### Step 5: Execute the Evaluation
1. In the n8n editor, filter **`EvaluateModelCases`** to 1 representative case (`maxRows: 1`) and run a single test first to verify credential and table bindings.
2. Filter out the completed first case, set `maxRows: 7`, and click **Evaluate all** once to run the remaining 7 cases.
3. Restore `EvaluateModelCases` to filtering off and `maxRows: 8` when finished, and keep the workflow inactive.

*(Note: If testing a single later row via MCP with a pinned trigger rather than the native Evaluation Trigger batch button, pin `RecordModelOutputs` inert because pinned triggers lack native evaluation row context; `RecordCaseById` updates the row by `caseId`.)*

---

## 3. Model Evaluation Scenarios & Recorded Results

### Test Coverage (8 Cases)
- **Extraction (5 cases):** Known order (`1001`), missing order number, refund request, multiple order numbers (`1001` & `1002`), and prompt-override instruction. Scored on strict JSON schema shape, `request_type`, and deduplicated digit-only `order_numbers`.
- **Drafting (3 cases):** Shipped order (with tracking & estimate), processing order (unknown dispatch timing), and delivered order (tracking, no estimate). Scored on non-empty text, expected status, exact tracking number, qualified estimate phrasing, absence of invented ISO dates, unknown-timing phrasing on processing orders, and absence of URLs (`http`/`www.`).

### Recorded Source Baseline
- **Result:** **8 / 8 passed** on Groq `qwen/qwen3.8-27b` (`temperature: 0`, `maxTokensToSample: 1024`, node retries disabled, workflow timeout `120s`).
- **Observed Usage:** 8 model calls, **3,892 total tokens** (3,516 prompt tokens, 376 completion tokens), zero retries or fallback calls. See [`verification-results.json`](verification-results.json) for full per-case metrics.
