# Duplicate Prevention & Manual Recovery Package

This folder contains the manual recovery caller workflow and recorded reliability verification results for the Order-Status Reply Drafter.

---

## Included Files

- [`recover-order-status-request.json`](recover-order-status-request.json) — Sanitized, inactive export of the **`RecoverOrderStatusRequest`** workflow.
- [`verification-results.json`](verification-results.json) — Sanitized record of source-environment reliability and end-to-end verification runs.

### Related Files in This Package
- **Main Workflow:** [`../main-workflow.json`](../main-workflow.json)
- **Ledger Schema & RPC SQL:** [`../../database/order-status-ledger.sql`](../../database/order-status-ledger.sql)
- **Database Setup Guide:** [`../../docs/ledger-database-setup.md`](../../docs/ledger-database-setup.md)
- **Operator Recovery Runbook:** [`../../docs/order-status-recovery-guide.md`](../../docs/order-status-recovery-guide.md)
- **Offline Recovery Unit Checks:** [`../../tests/check-recovery.js`](../../tests/check-recovery.js)

---

## Setup & Usage Summary

1. **Import Inactive:** Import `recover-order-status-request.json` into n8n and keep it inactive (manual execution only).
2. **Bind Target Main Workflow:** In the `RecoverThroughMain` node, replace `<MAIN_WORKFLOW_ID>` with your imported `DraftOrderStatusReply` workflow.
3. **Inspect Before Recovering:** `SelectUnresolvedRequest` defaults to blank identifiers and `writesSettled: false`. Before running recovery, always inspect the PostgreSQL ledger row, confirm the prior n8n execution is stopped/terminal, and check the Gmail thread for any existing draft.
4. **Never Delete Ledger Rows to Retry:** Deleting or resetting ledger rows breaks duplicate prevention. Follow the [Operator Recovery Guide](../../docs/order-status-recovery-guide.md) for all interrupted requests.
