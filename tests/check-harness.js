// Portable E2E harness workflow structural, expression, safety-gate, Data Table mapping, and swimlane-layout checks.
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");

const HARNESS_SPECS = [
  {
    file: "workflows/harness/run-order-status-regression.json",
    workflowName: "RunOrderStatusRegressionTest",
    functionalCount: 84,
    lanes: [
      {
        name: "Stage1Lane",
        color: 4,
        position: [-80, -144],
        width: 6080,
        height: 544,
        spineY: 0,
        subYs: [224],
        spine: [
          "StartRegression",
          "RunConfiguration",
          "ApiCredentialReady",
          "ReadStartingMain",
          "ReadStartingChild",
          "ReadStartingSender",
          "ReadProjectLabels",
          "CollectLabels",
          "ReadOrdersFixture",
          "CollectOrders",
          "CheckPendingInput",
          "CollectPending",
          "CheckUnfinishedSessions",
          "CheckReadiness",
          "ReadyToStart",
        ],
        sub: ["NotReady", "ReadinessRejected"],
      },
      {
        name: "Stage2Lane",
        color: 2,
        position: [-80, 432],
        width: 6080,
        height: 544,
        spineY: 576,
        subYs: [800],
        spine: [
          "HashMainCandidate",
          "HashChildCandidate",
          "CreateSession",
          "RecordSession",
          "RecordSessionRecorded",
          "RecheckSessionLock",
          "AcquireSessionLock",
          "OwnsSessionLock",
        ],
        sub: [
          "SessionNotStarted",
          "ConcurrentSummary",
          "SaveConcurrentResult",
          "SaveConcurrentResultRecorded",
          "ConcurrentStoreFailed",
        ],
      },
      {
        name: "Stage3Lane",
        color: 5,
        position: [-80, 1008],
        width: 6080,
        height: 544,
        spineY: 1152,
        subYs: [1376],
        spine: [
          "ActivationIntent",
          "RecordActivationIntent",
          "RecordActivationIntentRecorded",
          "StartMainIfNeeded",
          "StartValidatedMain",
          "WaitForFirstPoll",
          "WaitForCheckpoint",
          "ReadPollingCheckpoint",
          "VerifyPollingCheckpoint",
          "SessionControlOutcome",
          "CheckpointReady",
        ],
        sub: ["ActivationFailed", "CheckpointReadFailed"],
      },
      {
        name: "Stage4Lane",
        color: 6,
        position: [-80, 1584],
        width: 6080,
        height: 544,
        spineY: 1728,
        subYs: [1952],
        spine: [
          "CaseState",
          "ReadMainBeforeCase",
          "ReadChildBeforeCase",
          "PrepareNextCase",
          "CandidateStillReady",
          "SendIntent",
          "RecordSendIntent",
          "RecordSendIntentRecorded",
          "SendSelectedFixture",
          "RecordDeliveryState",
          "PersistDelivery",
          "PersistDeliveryRecorded",
          "ObserveActualCase",
          "RecordCaseResult",
          "PersistCaseResult",
          "PersistCaseResultRecorded",
          "MoreCases",
          "ContinueCaseState",
          "CaseControlOutcome",
        ],
        sub: [
          "CaseReadFailed",
          "SendUncertain",
          "DeliveryPersistFailed",
          "ObservationFailed",
          "ResultPersistFailed",
          "CleanupFromCase",
        ],
      },
      {
        name: "Stage5Lane",
        color: 4,
        position: [-80, 2160],
        width: 6080,
        height: 704,
        spineY: 2304,
        subYs: [2528, 2704],
        spine: [
          "CleanupState",
          "ReadMainBeforeRestore",
          "PlanRestore",
          "MustRestoreMain",
          "RestoreMainInactive",
          "VerifyFinalMain",
          "VerifyFinalChild",
          "BuildSuiteSummary",
          "SaveSuiteSummary",
          "SaveSuiteSummaryRecorded",
          "SuiteResults",
        ],
        sub: [
          "CleanupFailed",
          "RecordCleanupFailure",
          "RecordCleanupFailureRecorded",
          "CleanupFailureResults",
          "CleanupRecordFailed",
        ],
      },
    ],
  },
  {
    file: "workflows/harness/observe-order-status-case.json",
    workflowName: "ObserveOrderStatusRegressionCase",
    functionalCount: 20,
    lanes: [
      {
        name: "Stage1Lane",
        color: 4,
        position: [-80, -144],
        width: 2816,
        height: 544,
        spineY: 0,
        subYs: [224],
        spine: [
          "ReceiveCase",
          "BeginObservation",
          "ObservationTick",
          "FindExactSource",
          "CollectSource",
          "FindMainExecutions",
          "EvaluateTick",
          "ObservationSettled",
          "HasExecution",
        ],
        sub: [
          "NextObservationTick",
          "PaceReadRequests",
          "ReturnFailedObservation",
        ],
      },
      {
        name: "Stage2Lane",
        color: 5,
        position: [-80, 432],
        width: 2816,
        height: 544,
        spineY: 576,
        subYs: [800],
        spine: [
          "ReadActualExecution",
          "ReadSourceThread",
          "CaptureActualEvidence",
          "HasChildExecution",
          "ReadActualChild",
          "AssertActualCase",
        ],
        sub: ["NoChildEvidence", "ObservationReadFailed"],
      },
    ],
  },
  {
    file: "workflows/harness/sender-callable.json",
    workflowName: "Sender",
    functionalCount: 12,
    lanes: [
      {
        name: "Stage1Lane",
        color: 4,
        position: [-80, -80],
        width: 1920,
        height: 832,
      },
    ],
  },
  {
    file: "workflows/harness/evaluation-workflow.json",
    workflowName: "EvaluateOrderStatusModels",
    functionalCount: 12,
    lanes: [
      {
        name: "Stage1Lane",
        color: 4,
        position: [-80, -144],
        width: 1152,
        height: 400,
        spineY: 0,
        subYs: [],
        spine: ["EvaluateModelCases", "ReadModelCase", "SelectModelStage"],
        sub: [],
      },
      {
        name: "Stage2Lane",
        color: 2,
        position: [-80, 288],
        width: 1152,
        height: 896,
        spineY: 432,
        subYs: [624, 816, 1008],
        spine: ["ExtractModelFields", "ScoreExtraction"],
        sub: [
          "DraftModelReply",
          "GroqExtractionModel",
          "GroqDraftingModel",
          "ScoreDrafting",
          "ModelOutcome",
        ],
      },
      {
        name: "Stage3Lane",
        color: 5,
        position: [-80, 1216],
        width: 1152,
        height: 400,
        spineY: 1360,
        subYs: [],
        spine: ["RecordModelOutputs", "RecordCaseById"],
        sub: [],
      },
    ],
  },
];

let passed = 0;

function check(name, fn) {
  fn();
  passed++;
  console.log(`PASS ${name}`);
}

function readJson(relPath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relPath), "utf8"));
}

function isAligned16(value) {
  return Number.isInteger(value) && value % 16 === 0;
}

function assertBalancedExpression(expr, context) {
  assert(
    expr.startsWith("={{") && expr.endsWith("}}"),
    `${context}: expected ={{ ... }} wrapper`,
  );
  const matches = expr.match(/{{[\s\S]*?}}/g);
  assert.deepEqual(
    matches,
    [expr.slice(1)],
    `${context}: unbalanced or multiple {{ ... }} blocks`,
  );
  assert(
    !/\b(?:prototype|__proto__|constructor)\b/.test(expr),
    `${context}: accesses blocked Tournament sandbox property`,
  );
  // Verify inner JavaScript expression parses cleanly as a JS expression.
  const body = expr.slice(3, -2).trim();
  assert(body.length > 0, `${context}: empty expression body`);
  new Function("$", "$json", "$execution", `return (${body});`);
}

function visitStrings(value, visitor) {
  if (typeof value === "string") {
    visitor(value);
  } else if (value && typeof value === "object") {
    for (const child of Object.values(value)) {
      visitStrings(child, visitor);
    }
  }
}

function laneBounds(sticky) {
  const [x, y] = sticky.position;
  return {
    left: x,
    top: y,
    right: x + sticky.parameters.width,
    bottom: y + sticky.parameters.height,
  };
}

function boxesOverlap(a, b) {
  return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function checkWorkflowSpec(spec) {
  const wf = readJson(spec.file);
  assert.equal(wf.name, spec.workflowName, `${spec.file}: unexpected workflow name`);
  assert.equal(wf.active, false, `${spec.file}: active must remain false`);
  assert.deepEqual(wf.pinData || {}, {}, `${spec.file}: pinData must remain empty`);
  assert.deepEqual(wf.nodeGroups || [], [], `${spec.file}: nodeGroups must be []`);

  const stickyNotes = wf.nodes.filter((n) => n.type === "n8n-nodes-base.stickyNote");
  const functionalNodes = wf.nodes.filter((n) => n.type !== "n8n-nodes-base.stickyNote");

  assert.equal(
    stickyNotes.length,
    spec.lanes.length,
    `${spec.file}: expected ${spec.lanes.length} sticky notes`,
  );
  assert.equal(
    functionalNodes.length,
    spec.functionalCount,
    `${spec.file}: expected ${spec.functionalCount} functional nodes`,
  );

  // Unique IDs and names across all nodes.
  assert.equal(
    new Set(wf.nodes.map((n) => n.id)).size,
    wf.nodes.length,
    `${spec.file}: duplicate node id`,
  );
  assert.equal(
    new Set(wf.nodes.map((n) => n.name)).size,
    wf.nodes.length,
    `${spec.file}: duplicate node name`,
  );

  // Sticky-note geometry, color, plain markdown content, and zero overlap.
  const bounds = [];
  for (const laneSpec of spec.lanes) {
    const sticky = stickyNotes.find((n) => n.name === laneSpec.name);
    assert(sticky, `${spec.file}: missing sticky note ${laneSpec.name}`);
    assert.deepEqual(
      sticky.position,
      laneSpec.position,
      `${spec.file} ${laneSpec.name}: position mismatch`,
    );
    assert.equal(
      sticky.parameters.width,
      laneSpec.width,
      `${spec.file} ${laneSpec.name}: width mismatch`,
    );
    assert.equal(
      sticky.parameters.height,
      laneSpec.height,
      `${spec.file} ${laneSpec.name}: height mismatch`,
    );
    assert.equal(
      sticky.parameters.color,
      laneSpec.color,
      `${spec.file} ${laneSpec.name}: color mismatch`,
    );
    assert.notEqual(
      sticky.parameters.color,
      3,
      `${spec.file} ${laneSpec.name}: sticky note color must not be red (3)`,
    );
    assert(
      isAligned16(sticky.position[0]) &&
        isAligned16(sticky.position[1]) &&
        isAligned16(sticky.parameters.width) &&
        isAligned16(sticky.parameters.height),
      `${spec.file} ${laneSpec.name}: sticky note geometry not 16px-aligned`,
    );
    assert(
      typeof sticky.parameters.content === "string" &&
        sticky.parameters.content.startsWith("## Stage ") &&
        !sticky.parameters.content.includes("={{") &&
        !sticky.parameters.content.includes("$("),
      `${spec.file} ${laneSpec.name}: sticky note must contain plain markdown`,
    );
    bounds.push({ name: laneSpec.name, box: laneBounds(sticky) });
  }

  for (let i = 0; i < bounds.length; i++) {
    for (let j = i + 1; j < bounds.length; j++) {
      assert(
        !boxesOverlap(bounds[i].box, bounds[j].box),
        `${spec.file}: sticky notes ${bounds[i].name} and ${bounds[j].name} overlap`,
      );
    }
  }

  // 16px grid alignment, zero functional node overlaps, and strict single-lane containment.
  for (let i = 0; i < functionalNodes.length; i++) {
    const a = functionalNodes[i];
    assert(
      Array.isArray(a.position) &&
        a.position.length === 2 &&
        isAligned16(a.position[0]) &&
        isAligned16(a.position[1]),
      `${spec.file} ${a.name}: position ${JSON.stringify(a.position)} not 16px-aligned`,
    );
    const containing = bounds.filter(
      ({ box }) =>
        a.position[0] >= box.left + 16 &&
        a.position[0] <= box.right - 16 &&
        a.position[1] >= box.top + 16 &&
        a.position[1] <= box.bottom - 16,
    );
    assert.equal(
      containing.length,
      1,
      `${spec.file} ${a.name}: expected strictly 1 containing lane, got ${containing.map((c) => c.name).join(",") || "none"}`,
    );
    for (let j = i + 1; j < functionalNodes.length; j++) {
      const b = functionalNodes[j];
      const dx = Math.abs(a.position[0] - b.position[0]);
      const dy = Math.abs(a.position[1] - b.position[1]);
      assert(
        !(dx < 160 && dy < 112),
        `${spec.file}: functional nodes ${a.name} (${a.position}) and ${b.name} (${b.position}) overlap`,
      );
    }
  }

  // Exact spine/sub-row node memberships when specified.
  for (const laneSpec of spec.lanes) {
    if (!laneSpec.spine) continue;
    const box = bounds.find((b) => b.name === laneSpec.name).box;
    const laneNodes = functionalNodes.filter(
      (n) =>
        n.position[0] >= box.left &&
        n.position[0] <= box.right &&
        n.position[1] >= box.top &&
        n.position[1] <= box.bottom,
    );
    const actualSpine = laneNodes
      .filter((n) => n.position[1] === laneSpec.spineY)
      .sort((a, b) => a.position[0] - b.position[0])
      .map((n) => n.name);
    const actualSub = laneNodes
      .filter((n) => laneSpec.subYs.includes(n.position[1]))
      .sort((a, b) => a.position[0] - b.position[0] || a.position[1] - b.position[1])
      .map((n) => n.name);
    assert.deepEqual(
      actualSpine,
      laneSpec.spine,
      `${spec.file} ${laneSpec.name}: spine nodes mismatch`,
    );
    assert.deepEqual(
      actualSub,
      laneSpec.sub,
      `${spec.file} ${laneSpec.name}: sub-row nodes mismatch`,
    );
    assert.equal(
      laneNodes.length,
      laneSpec.spine.length + laneSpec.sub.length,
      `${spec.file} ${laneSpec.name}: unexpected extra nodes outside spine/sub-rows`,
    );
  }

  // Expression syntax, $('NodeName') targets, and connection integrity.
  const allNames = new Set(wf.nodes.map((n) => n.name));
  const functionalNames = new Set(functionalNodes.map((n) => n.name));

  for (const node of wf.nodes) {
    visitStrings(node.parameters, (str) => {
      if (str.startsWith("={{")) {
        assertBalancedExpression(str, `${spec.file} ${node.name}`);
      }
      for (const [, ref] of str.matchAll(/\$\('([^']+)'\)/g)) {
        assert(
          functionalNames.has(ref),
          `${spec.file} ${node.name}: references unknown node $('${ref}')`,
        );
      }
    });
  }

  const connected = new Set();
  for (const [source, outputTypes] of Object.entries(wf.connections || {})) {
    assert(
      functionalNames.has(source),
      `${spec.file}: connection source ${source} missing from functional nodes`,
    );
    connected.add(source);
    for (const branches of Object.values(outputTypes)) {
      for (const targets of branches) {
        for (const edge of targets || []) {
          assert(
            allNames.has(edge.node) && functionalNames.has(edge.node),
            `${spec.file}: connection target ${edge.node} from ${source} missing`,
          );
          connected.add(edge.node);
        }
      }
    }
  }
  for (const node of functionalNodes) {
    assert(
      connected.has(node.name),
      `${spec.file}: disconnected functional node ${node.name}`,
    );
  }
}

for (const spec of HARNESS_SPECS) {
  check(`structure-and-layout/${spec.workflowName}`, () => checkWorkflowSpec(spec));
}

check("safety-gates-and-placeholders/RunConfiguration", () => {
  const runner = readJson("workflows/harness/run-order-status-regression.json");
  const cfg = runner.nodes.find((n) => n.name === "RunConfiguration");
  assert(cfg, "missing RunConfiguration node");
  assert.equal(cfg.parameters.assignments.assignments.length, 19);
  const byName = Object.fromEntries(
    cfg.parameters.assignments.assignments.map((a) => [a.name, a.value]),
  );
  assert.equal(byName.observerId, undefined, "observerId must be removed from RunConfiguration");
  assert.equal(byName.runEnabled, false, "runEnabled must default to false");
  assert.equal(
    byName.apiCredentialReady,
    false,
    "apiCredentialReady must default to false",
  );
  assert.equal(
    byName.arrivalFilterConfirmed,
    false,
    "arrivalFilterConfirmed must default to false",
  );
  assert.equal(byName.mode, "regression", "mode must default to regression");
  for (const [field, expected] of [
    ["mainId", "<MAIN_WORKFLOW_ID>"],
    ["mainVersion", "<VALIDATED_MAIN_VERSION>"],
    ["childId", "<GET_ORDER_WORKFLOW_ID>"],
    ["childVersion", "<VALIDATED_GET_ORDER_VERSION>"],
    ["senderId", "<SENDER_WORKFLOW_ID>"],
    ["senderVersion", "<VERIFIED_SENDER_VERSION>"],
    ["customer", "<CUSTOMER_EMAIL>"],
    ["receiver", "<RECEIVER_EMAIL>"],
    ["receiverGmailCredentialId", "<RECEIVER_GMAIL_CREDENTIAL_ID>"],
    ["ordersSpreadsheetId", "<ORDERS_SPREADSHEET_ID>"],
    ["ordersSheetGid", "<ORDERS_SHEET_GID>"],
    ["sessionDataTableId", "<SESSION_DATA_TABLE_ID>"],
    ["pinsConfirmedVersion", "<VALIDATED_MAIN_VERSION>"],
  ]) {
    assert.equal(byName[field], expected, `RunConfiguration.${field} placeholder changed`);
  }
});

check("runner-subworkflows-and-sheets-options", () => {
  const runner = readJson("workflows/harness/run-order-status-regression.json");
  const byName = (name) => {
    const node = runner.nodes.find((n) => n.name === name);
    assert(node, `missing ${name} node`);
    return node;
  };

  const sendNode = byName("SendSelectedFixture");
  assert.equal(sendNode.type, "n8n-nodes-base.executeWorkflow");
  assert.equal(sendNode.typeVersion, 1.4);
  assert.deepEqual(sendNode.parameters.workflowId, {
    __rl: true,
    mode: "list",
    value: "<SENDER_WORKFLOW_ID>",
  });
  assert.equal(sendNode.parameters.workflowInputs.mappingMode, "defineBelow");
  assert.deepEqual(sendNode.parameters.workflowInputs.value, {
    subject: "={{ $('SendIntent').item.json.fixture.subject }}",
    body: "={{ $('SendIntent').item.json.fixture.body }}",
    senderMode: "={{ $('SendIntent').item.json.fixture.senderMode }}",
  });
  assert.deepEqual(
    sendNode.parameters.workflowInputs.schema.map((s) => [s.id, s.type, s.required]),
    [
      ["subject", "string", true],
      ["body", "string", true],
      ["senderMode", "string", true],
    ],
  );
  assert.equal(sendNode.parameters.workflowInputs.attemptToConvertTypes, false);
  assert.equal(sendNode.parameters.options?.waitForSubWorkflow, true);
  assert(
    !JSON.stringify(sendNode.parameters).includes("$('RunConfiguration')"),
    "SendSelectedFixture must not reference $('RunConfiguration')",
  );

  const observeNode = byName("ObserveActualCase");
  assert.equal(observeNode.type, "n8n-nodes-base.executeWorkflow");
  assert.equal(observeNode.typeVersion, 1.4);
  assert.deepEqual(observeNode.parameters.workflowId, {
    __rl: true,
    mode: "list",
    value: "<OBSERVER_WORKFLOW_ID>",
  });
  assert.equal(observeNode.parameters.workflowInputs.mappingMode, "defineBelow");
  assert.deepEqual(observeNode.parameters.workflowInputs.value, {
    state: "={{ $('RecordDeliveryState').item.json }}",
  });
  assert.deepEqual(
    observeNode.parameters.workflowInputs.schema.map((s) => [s.id, s.type, s.required]),
    [["state", "object", true]],
  );
  assert.equal(observeNode.parameters.workflowInputs.attemptToConvertTypes, false);
  assert.equal(observeNode.parameters.options?.waitForSubWorkflow, true);
  assert(
    !JSON.stringify(observeNode.parameters).includes("$('RunConfiguration')"),
    "ObserveActualCase must not reference $('RunConfiguration')",
  );

  const sheetsNode = byName("ReadOrdersFixture");
  assert.equal(sheetsNode.type, "n8n-nodes-base.googleSheets");
  assert.deepEqual(sheetsNode.parameters.documentId, {
    __rl: true,
    mode: "id",
    value: "={{ $('RunConfiguration').first().json.ordersSpreadsheetId }}",
  });
  assert.deepEqual(sheetsNode.parameters.sheetName, {
    __rl: true,
    mode: "id",
    value: "={{ $('RunConfiguration').first().json.ordersSheetGid }}",
  });
  assert.deepEqual(sheetsNode.parameters.options, {
    dataLocationOnSheet: {
      values: {
        rangeDefinition: "specifyRangeA1",
        range: "A:F",
      },
    },
    outputFormatting: {
      values: {
        general: "UNFORMATTED_VALUE",
        date: "SERIAL_NUMBER",
      },
    },
    returnFirstMatch: false,
  });
});

check("safety-gates-and-placeholders/SenderConfig", () => {
  const sender = readJson("workflows/harness/sender-callable.json");
  const cfg = sender.nodes.find((n) => n.name === "SenderConfig");
  assert(cfg, "missing SenderConfig node");
  const byName = Object.fromEntries(
    cfg.parameters.assignments.assignments.map((a) => [a.name, a.value]),
  );
  assert.deepEqual(Object.keys(byName), ["receiverEmail"]);
  assert.equal(byName.receiverEmail, "<RECEIVER_EMAIL>");
  assert.equal(byName.customerEmail, undefined);
});

check("sender-node-type-and-symmetry", () => {
  const sender = readJson("workflows/harness/sender-callable.json");
  assert.equal(
    sender.nodes.filter((n) => n.type === "n8n-nodes-base.emailSend").length,
    0,
    "sender-callable.json must have zero emailSend nodes",
  );
  for (const node of sender.nodes) {
    assert.equal(
      node.credentials,
      undefined,
      `sender-callable.json ${node.name}: committed credentials block must be absent`,
    );
  }
  const sendAsCustomer = sender.nodes.find((n) => n.name === "SendAsCustomer");
  const sendToSelf = sender.nodes.find((n) => n.name === "SendToSelf");
  assert(sendAsCustomer, "missing SendAsCustomer node");
  assert(sendToSelf, "missing SendToSelf node");
  assert.equal(sendAsCustomer.id, "t016-node-1");
  assert.equal(sendToSelf.id, "t016-node-2");
  for (const node of [sendAsCustomer, sendToSelf]) {
    assert.equal(node.type, "n8n-nodes-base.gmail", `${node.name}: expected Gmail node`);
    assert.equal(node.typeVersion, 2.2, `${node.name}: expected typeVersion 2.2`);
    assert.equal(
      node.parameters.sendTo,
      "={{ $('SenderConfig').first().json.receiverEmail }}",
      `${node.name}: unexpected sendTo`,
    );
    assert.equal(
      node.parameters.subject,
      "={{ $('ValidateFixture').item.json.subject }}",
      `${node.name}: unexpected subject`,
    );
    assert.equal(node.parameters.emailType, "text", `${node.name}: expected emailType text`);
    assert.equal(
      node.parameters.message,
      "={{ $('ValidateFixture').item.json.body }}",
      `${node.name}: unexpected message`,
    );
    assert.equal(
      node.parameters.options?.appendAttribution,
      false,
      `${node.name}: expected appendAttribution false`,
    );
    assert.equal(
      node.parameters.fromEmail,
      undefined,
      `${node.name}: fromEmail must be undefined`,
    );
  }
  const customerDelivery = sender.nodes.find((n) => n.name === "CustomerDelivery");
  assert(customerDelivery, "missing CustomerDelivery node");
  assert(
    customerDelivery.parameters.jsonOutput.includes("$('SendAsCustomer').item.json"),
    "CustomerDelivery must reference $('SendAsCustomer').item.json",
  );
});

check("runner-datatable-column-mappings", () => {
  const runner = readJson("workflows/harness/run-order-status-regression.json");
  const expectedDataTableId = {
    __rl: true,
    mode: "id",
    value: "={{ $('RunConfiguration').first().json.sessionDataTableId }}",
  };
  const expectedSchema = [
    ["sessionId", "string"],
    ["active", "boolean"],
    ["status", "string"],
    ["state_object", "string"],
    ["summary_object", "string"],
  ];
  const writeNodes = [
    ["RecordSession", "CreateSession", "insert"],
    ["RecordActivationIntent", "ActivationIntent", "update"],
    ["RecordSendIntent", "SendIntent", "update"],
    ["PersistDelivery", "RecordDeliveryState", "update"],
    ["PersistCaseResult", "RecordCaseResult", "update"],
    ["SaveSuiteSummary", "BuildSuiteSummary", "update"],
    ["SaveConcurrentResult", "ConcurrentSummary", "update"],
    ["RecordCleanupFailure", "CleanupFailed", "update"],
  ];
  const readNodes = ["CheckUnfinishedSessions", "RecheckSessionLock"];

  const allDataTableNodes = runner.nodes.filter(
    (n) => n.type === "n8n-nodes-base.dataTable",
  );
  assert.equal(
    allDataTableNodes.length,
    writeNodes.length + readNodes.length,
    "unexpected number of dataTable nodes in RunOrderStatusRegressionTest",
  );

  for (const [nodeName, upstream, expectedOp] of writeNodes) {
    const node = runner.nodes.find((n) => n.name === nodeName);
    assert(node, `missing ${nodeName} node`);
    assert.equal(
      node.type,
      "n8n-nodes-base.dataTable",
      `${nodeName}: expected dataTable node`,
    );
    assert.equal(
      node.parameters.operation || "insert",
      expectedOp,
      `${nodeName}: unexpected operation`,
    );
    assert.deepEqual(
      node.parameters.dataTableId,
      expectedDataTableId,
      `${nodeName}: unexpected dataTableId`,
    );
    assert.equal(
      node.parameters.columns?.mappingMode,
      "defineBelow",
      `${nodeName}: expected mappingMode defineBelow`,
    );
    assert.deepEqual(
      node.parameters.columns?.value,
      {
        sessionId: `={{ $('${upstream}').item.json.sessionId }}`,
        active: `={{ $('${upstream}').item.json.active !== false }}`,
        status: `={{ $('${upstream}').item.json.summary?.status || $('${upstream}').item.json.error?.code || 'RUNNING' }}`,
        state_object: `={{ JSON.stringify($('${upstream}').item.json) }}`,
        summary_object: `={{ JSON.stringify($('${upstream}').item.json.summary || null) }}`,
      },
      `${nodeName}: columns.value mismatch`,
    );
    assert.deepEqual(
      (node.parameters.columns?.schema || []).map((s) => [s.id, s.type]),
      expectedSchema,
      `${nodeName}: columns.schema mismatch`,
    );
    if (expectedOp === "update") {
      assert.equal(
        node.parameters.matchType,
        "allConditions",
        `${nodeName}: expected matchType allConditions`,
      );
      const conditions = node.parameters.filters?.conditions;
      assert(
        Array.isArray(conditions) && conditions.length === 1,
        `${nodeName}: expected 1 filter condition`,
      );
      assert.equal(
        conditions[0].keyName,
        "sessionId",
        `${nodeName}: filter must match sessionId`,
      );
      assert(
        conditions[0].condition === undefined || conditions[0].condition === "eq",
        `${nodeName}: unexpected filter operator ${conditions[0].condition}`,
      );
      assert.equal(
        conditions[0].keyValue,
        `={{ $('${upstream}').item.json.sessionId }}`,
        `${nodeName}: filter keyValue mismatch`,
      );
    }
  }

  for (const nodeName of readNodes) {
    const node = runner.nodes.find((n) => n.name === nodeName);
    assert(node, `missing ${nodeName} node`);
    assert.equal(
      node.type,
      "n8n-nodes-base.dataTable",
      `${nodeName}: expected dataTable node`,
    );
    assert.equal(
      node.parameters.operation,
      "get",
      `${nodeName}: expected operation get`,
    );
    assert.deepEqual(
      node.parameters.dataTableId,
      expectedDataTableId,
      `${nodeName}: unexpected dataTableId`,
    );
    assert.equal(
      node.parameters.matchType,
      "allConditions",
      `${nodeName}: expected matchType allConditions`,
    );
    assert.deepEqual(
      node.parameters.filters?.conditions,
      [{ keyName: "active", condition: "isTrue" }],
      `${nodeName}: unexpected active filter`,
    );
  }
});

check("evaluation-datatable-column-mappings", () => {
  const evalWf = readJson("workflows/harness/evaluation-workflow.json");
  const dataTableNodes = evalWf.nodes.filter(
    (n) => n.type === "n8n-nodes-base.dataTable",
  );
  assert.equal(
    dataTableNodes.length,
    1,
    "expected exactly 1 dataTable node in EvaluateOrderStatusModels",
  );

  const node = evalWf.nodes.find((n) => n.name === "RecordCaseById");
  assert(node, "missing RecordCaseById node");
  assert.equal(
    node.type,
    "n8n-nodes-base.dataTable",
    "RecordCaseById: expected dataTable node",
  );
  assert.equal(
    node.parameters.operation,
    "update",
    "RecordCaseById: expected operation update",
  );
  assert.deepEqual(
    node.parameters.dataTableId,
    {
      __rl: true,
      mode: "id",
      value: "<MODEL_TEST_DATA_TABLE_ID>",
    },
    "RecordCaseById: unexpected dataTableId",
  );
  assert.equal(
    node.parameters.matchType,
    "allConditions",
    "RecordCaseById: expected matchType allConditions",
  );
  assert.deepEqual(
    node.parameters.filters?.conditions,
    [
      {
        keyName: "caseId",
        condition: "eq",
        keyValue: "={{ $('ReadModelCase').item.json.caseId }}",
      },
    ],
    "RecordCaseById: filters.conditions mismatch",
  );
  assert.equal(
    node.parameters.columns?.mappingMode,
    "defineBelow",
    "RecordCaseById: expected mappingMode defineBelow",
  );
  assert.deepEqual(
    node.parameters.columns?.value,
    {
      actual_object: "={{ JSON.stringify($('ModelOutcome').item.json.actual) }}",
      metrics_object: "={{ JSON.stringify($('ModelOutcome').item.json.metrics) }}",
      pass: "={{ $('ModelOutcome').item.json.pass }}",
      error: "={{ $('ModelOutcome').item.json.error }}",
      run_object:
        "={{ JSON.stringify({source:$('ModelOutcome').item.json.source,executionId:$execution.id,services:['GroqExtractionModel','GroqDraftingModel'].filter(n=>$(n).isExecuted),recordingKind:$('ReadModelCase').item.json.recordingKind||'native-trigger'}) }}",
    },
    "RecordCaseById: columns.value mismatch",
  );
  assert.deepEqual(
    (node.parameters.columns?.schema || []).map((s) => [s.id, s.type]),
    [
      ["actual_object", "string"],
      ["metrics_object", "string"],
      ["pass", "boolean"],
      ["error", "string"],
      ["run_object", "string"],
    ],
    "RecordCaseById: columns.schema mismatch",
  );
});

console.log(
  `PASS harness: ${passed} offline E2E harness structural, expression, safety-gate, Data Table mapping, and swimlane checks passed.`,
);
