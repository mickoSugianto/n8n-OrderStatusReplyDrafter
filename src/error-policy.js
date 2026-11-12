"use strict";

function escapeSlack(text, inCode = false) {
  const clean = String(text ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "");
  return inCode ? clean.replace(/[*_~]/g, "") : clean;
}

function sanitizeReason(text) {
  let clean = String(text ?? "").replace(/\s+/g, " ").trim();
  clean = clean.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    "[REDACTED_EMAIL]",
  );
  clean = clean.replace(
    /(?:"[^"]{16,}"|'[^']{16,}'|`[^`]{16,}`)/g,
    "[REDACTED_TEXT]",
  );
  clean = escapeSlack(clean);
  if (clean.length > 160) {
    clean = clean.slice(0, 159).replace(/&[a-z]*$/i, "") + "…";
  }
  return clean;
}

function formatErrorAlert(input, config) {
  function escapeSlack(text, inCode = false) {
    const clean = String(text ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/`/g, "");
    return inCode ? clean.replace(/[*_~]/g, "") : clean;
  }

  function sanitizeReason(text) {
    let clean = String(text ?? "").replace(/\s+/g, " ").trim();
    clean = clean.replace(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
      "[REDACTED_EMAIL]",
    );
    clean = clean.replace(
      /(?:"[^"]{16,}"|'[^']{16,}'|`[^`]{16,}`)/g,
      "[REDACTED_TEXT]",
    );
    clean = escapeSlack(clean);
    if (clean.length > 160) {
      clean = clean.slice(0, 159).replace(/&[a-z]*$/i, "") + "…";
    }
    return clean;
  }

  const nonEmptyString = (val) =>
    typeof val === "string" && val.trim().length > 0 ? val.trim() : null;
  const firstString = (...vals) => {
    for (const val of vals) {
      const str = nonEmptyString(val);
      if (str !== null) return str;
    }
    return null;
  };

  const root =
    input &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    input.payload &&
    typeof input.payload === "object" &&
    !Array.isArray(input.payload)
      ? input.payload
      : input && typeof input === "object" && !Array.isArray(input)
        ? input
        : {};

  const workflow =
    root.workflow && typeof root.workflow === "object" ? root.workflow : {};
  const workflow_name = nonEmptyString(workflow.name);

  const hasTrigger = Boolean(
    root.trigger && typeof root.trigger === "object" && !Array.isArray(root.trigger),
  );
  const hasExecution = Boolean(
    root.execution &&
      typeof root.execution === "object" &&
      !Array.isArray(root.execution),
  );
  const isTriggerFailure = hasTrigger && !hasExecution;

  const trigger = hasTrigger ? root.trigger : {};
  const execution = hasExecution ? root.execution : {};

  const execution_id =
    !isTriggerFailure &&
    execution.id != null &&
    String(execution.id).trim() !== ""
      ? String(execution.id).trim()
      : null;
  const execution_url = !isTriggerFailure
    ? nonEmptyString(execution.url)
    : null;
  const failed_node = !isTriggerFailure
    ? nonEmptyString(execution.lastNodeExecuted)
    : null;

  const rawExecError = !isTriggerFailure
    ? firstString(execution.error?.message, execution.error)
    : null;
  const rawTriggerError = isTriggerFailure
    ? firstString(trigger.error?.message, trigger.error)
    : null;

  const parseJsonObject = (val) => {
    const str = nonEmptyString(val);
    if (str === null || !str.startsWith("{") || !str.endsWith("}")) {
      return null;
    }
    try {
      const candidate = JSON.parse(str);
      return candidate &&
        typeof candidate === "object" &&
        !Array.isArray(candidate)
        ? candidate
        : null;
    } catch (_) {
      return null;
    }
  };
  const nonJsonString = (val) => {
    const str = nonEmptyString(val);
    return str !== null && parseJsonObject(str) === null ? str : null;
  };

  const parsed = parseJsonObject(rawExecError);
  const rawNestedError = firstString(parsed?.error?.message, parsed?.error);
  const nestedParsed = parseJsonObject(rawNestedError);

  const quarantineObj =
    parsed?.quarantine &&
    typeof parsed.quarantine === "object" &&
    !Array.isArray(parsed.quarantine)
      ? parsed.quarantine
      : null;
  const recordObj =
    parsed?.record &&
    typeof parsed.record === "object" &&
    !Array.isArray(parsed.record)
      ? parsed.record
      : quarantineObj?.record &&
          typeof quarantineObj.record === "object" &&
          !Array.isArray(quarantineObj.record)
        ? quarantineObj.record
        : null;

  const reasonSource = nestedParsed || parsed;
  const reasonQuarantine =
    reasonSource?.quarantine &&
    typeof reasonSource.quarantine === "object" &&
    !Array.isArray(reasonSource.quarantine)
      ? reasonSource.quarantine
      : null;
  const reasonRecord =
    reasonSource?.record &&
    typeof reasonSource.record === "object" &&
    !Array.isArray(reasonSource.record)
      ? reasonSource.record
      : reasonQuarantine?.record &&
          typeof reasonQuarantine.record === "object" &&
          !Array.isArray(reasonQuarantine.record)
        ? reasonQuarantine.record
        : null;

  let classification;
  let title;

  if (isTriggerFailure) {
    classification = "trigger_failure";
    title = "Trigger Failure";
  } else if (workflow_name === "RecoverOrderStatusRequest") {
    classification = "recovery_sweep_failed";
    title = "Recovery Sweep Failed";
  } else if (quarantineObj?.quarantined === true && recordObj !== null) {
    classification = "quarantined_needs_inspection";
    title = "Needs Inspection (quarantined)";
  } else if (recordObj !== null) {
    classification = "post_claim_needs_inspection";
    title =
      recordObj.phase === "DraftIntentRecorded"
        ? "Needs Inspection (uncertain Gmail write)"
        : "Needs Inspection";
  } else {
    classification = "pre_claim_or_unhandled";
    title = "Pre-Claim or Unhandled Error";
  }

  const rawReason = isTriggerFailure
    ? rawTriggerError || "(non-string error omitted)"
    : firstString(
        reasonQuarantine?.quarantined === true
          ? reasonRecord?.recovery?.last_quarantine?.error
          : null,
        reasonRecord?.last_error,
        reasonSource?.reason,
        nonJsonString(
          nestedParsed
            ? firstString(nestedParsed.error?.message, nestedParsed.error)
            : rawNestedError,
        ),
        reasonQuarantine?.result,
        parsed ? null : rawExecError,
      ) || "(non-string error omitted)";

  const hasRecord = recordObj !== null;
  const source_message_id = firstString(
    recordObj?.source_message_id,
    parsed?.sourceMessageId,
    parsed?.source_message_id,
  );
  const thread_id = hasRecord ? nonEmptyString(recordObj?.thread_id) : null;
  const phase = hasRecord ? nonEmptyString(recordObj?.phase) : null;
  const status = hasRecord ? nonEmptyString(recordObj?.status) : null;
  const outcome = hasRecord ? nonEmptyString(recordObj?.outcome) : null;
  const recovery_attempts =
    hasRecord &&
    typeof recordObj?.recovery_attempts === "number" &&
    Number.isFinite(recordObj.recovery_attempts)
      ? recordObj.recovery_attempts
      : null;
  const owner_token = firstString(
    recordObj?.owner_token,
    parsed?.expectedOwnerToken,
    parsed?.owner_token,
  );
  const draft_id = hasRecord ? nonEmptyString(recordObj?.draft_id) : null;

  const reason = sanitizeReason(rawReason);

  const lines = [
    `:rotating_light: *Order Status Drafter — ${escapeSlack(title)}*`,
  ];

  if (!isTriggerFailure && (execution_id || execution_url || failed_node)) {
    const execParts = [];
    if (execution_url && execution_id) {
      execParts.push(
        `<${escapeSlack(execution_url)}|#${escapeSlack(execution_id, true)}>`,
      );
    } else if (execution_id) {
      execParts.push(`#${escapeSlack(execution_id, true)}`);
    } else if (execution_url) {
      execParts.push(`<${escapeSlack(execution_url)}>`);
    }
    if (workflow_name) {
      execParts.push(escapeSlack(workflow_name));
    }
    if (failed_node) {
      execParts.push(`failed at \`${escapeSlack(failed_node, true)}\``);
    }
    lines.push(`• *Execution:* ${execParts.join(" · ")}`);
  }

  if (source_message_id || thread_id) {
    const emailParts = [];
    if (source_message_id) {
      emailParts.push(`source=\`${escapeSlack(source_message_id, true)}\``);
    }
    if (thread_id) {
      emailParts.push(`thread=\`${escapeSlack(thread_id, true)}\``);
    }
    lines.push(`• *Email:* ${emailParts.join(" · ")}`);
  }

  if (phase || status || outcome || recovery_attempts !== null) {
    const ledgerParts = [];
    if (phase) ledgerParts.push(`phase=\`${escapeSlack(phase, true)}\``);
    if (status) ledgerParts.push(`status=\`${escapeSlack(status, true)}\``);
    if (outcome) ledgerParts.push(`outcome=\`${escapeSlack(outcome, true)}\``);
    if (recovery_attempts !== null) {
      ledgerParts.push(
        `attempts=\`${escapeSlack(String(recovery_attempts), true)}\``,
      );
    }
    lines.push(`• *Ledger:* ${ledgerParts.join(" · ")}`);
  }

  if (owner_token || draft_id) {
    const recoveryParts = [];
    if (owner_token) {
      recoveryParts.push(
        `expectedOwnerToken=\`${escapeSlack(owner_token, true)}\``,
      );
    }
    if (draft_id) {
      recoveryParts.push(`draft=\`${escapeSlack(draft_id, true)}\``);
    }
    lines.push(`• *Recovery inputs:* ${recoveryParts.join(" · ")}`);
  }

  lines.push(`• *Reason:* ${reason}`);

  return {
    classification,
    reason,
    workflow_name,
    execution_id,
    execution_url,
    failed_node,
    source_message_id,
    thread_id,
    phase,
    status,
    outcome,
    recovery_attempts,
    owner_token,
    draft_id,
    slack_text: lines.join("\n"),
  };
}

module.exports = { formatErrorAlert, sanitizeReason, escapeSlack };
