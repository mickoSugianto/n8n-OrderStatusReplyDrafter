"use strict";
const assert = require("node:assert/strict");
const policy = require("../src/main-policy"),
  validator = require("../src/validate-order"),
  errorPolicy = require("../src/error-policy");
const policies = { ...policy, ...errorPolicy };
const { cases } = require("./fixtures/order-fixtures");
const { checkSourceLinkage } = require("./check-source-linkage");
let logicPassed = 0,
  auditPassed = 0,
  failed = 0;
function check(kind, name, fn) {
  try {
    fn();
    if (kind === "LOGIC") logicPassed++;
    else auditPassed++;
    console.log(`PASS ${kind} ${name}`);
  } catch (e) {
    failed++;
    console.error(`FAIL ${kind} ${name}: ${e.message}`);
  }
}
for (const c of cases.filter((c) => c.mode !== "lookup"))
  check("LOGIC", "validator/" + c.id, () => {
    const expected =
      c.expected === "invalid_data"
        ? {
            lookup_status: "invalid_data",
            order: null,
            reason: "invalid_order_data",
            invalid_fields: c.fields,
          }
        : { lookup_status: c.expected, order: c.expectedOrder };
    assert.deepEqual(validator.validateOrder(c.order_number, c.rows), expected);
  });
for (const c of require("./fixtures/policy-cases.json"))
  check("LOGIC", c.fn + "/" + c.id, () => {
    const fn = policies[c.fn];
    assert.equal(typeof fn, "function", "missing policy function " + c.fn);
    if (c.throws) {
      assert.throws(() => fn(...c.args), new RegExp(c.throws));
      return;
    }
    const actual = fn(...c.args);
    for (const [key, value] of Object.entries(c.expected))
      assert.deepEqual(actual[key], value, key);
    for (const key of c.absent || [])
      assert.equal(actual[key], undefined, "unverified " + key);
    for (const sub of c.includes || [])
      assert(
        typeof actual.slack_text === "string" && actual.slack_text.includes(sub),
        "missing expected slack_text substring: " + sub,
      );
    if (c.forbidden && c.forbidden.length > 0) {
      const serialized = JSON.stringify(actual);
      for (const bad of c.forbidden) {
        assert(
          !actual.slack_text?.includes(bad),
          "forbidden string leaked in slack_text: " + bad,
        );
        assert(
          !serialized.includes(bad),
          "forbidden string leaked in output object: " + bad,
        );
      }
    }
    if (typeof c.maxReasonLength === "number") {
      assert(
        typeof actual.reason === "string" &&
          actual.reason.length <= c.maxReasonLength,
        "reason length exceeds " + c.maxReasonLength,
      );
    }
  });
check("AUDIT", "captured-source-linkage", () =>
  checkSourceLinkage(
    require("../src/source-linkage.json"),
    require("../src/model-definitions.json"),
    policy,
    validator,
    errorPolicy,
  ),
);
check("AUDIT", "model-dataset-scope", () => {
  const cases = require("./fixtures/evaluation-cases.json").cases;
  assert.equal(cases.length, 8);
  assert.equal(new Set(cases.map((c) => c.caseId)).size, 8);
  assert.equal(cases.filter((c) => c.stage === "extraction").length, 5);
  assert.equal(cases.filter((c) => c.stage === "drafting").length, 3);
});
check("AUDIT", "model-only-surface", () => {
  const w = require("../workflows/harness/evaluation-workflow.json");
  assert.equal(w.active, false);
  const allowed = new Set([
    "n8n-nodes-base.evaluationTrigger",
    "n8n-nodes-base.evaluation",
    "n8n-nodes-base.dataTable",
    "n8n-nodes-base.if",
    "n8n-nodes-base.set",
    "n8n-nodes-base.noOp",
    "@n8n/n8n-nodes-langchain.informationExtractor",
    "@n8n/n8n-nodes-langchain.chainLlm",
    "@n8n/n8n-nodes-langchain.lmChatGroq",
  ]);
  for (const n of w.nodes) {
    assert(allowed.has(n.type), n.name);
    assert(!n.credentials);
    assert(!n.retryOnFail);
    if (n.parameters.dataTableId)
      assert.equal(
        n.parameters.dataTableId.value,
        "<MODEL_TEST_DATA_TABLE_ID>",
      );
  }
  assert.equal(w.nodes.filter((n) => n.type === "n8n-nodes-base.if").length, 1);
  assert.equal(
    w.nodes.find((n) => n.type === "n8n-nodes-base.evaluationTrigger")
      .parameters.maxRows,
    8,
  );
});
console.log(
  `Fresh logic cases: ${logicPassed} passed. Source/static audits: ${auditPassed} passed. Failures: ${failed}. Local only; no network or historical-result assertions.`,
);
process.exitCode = failed ? 1 : 0;
