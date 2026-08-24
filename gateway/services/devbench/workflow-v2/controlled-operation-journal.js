import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { canonicalSha256 } from "./envelope-store.js";

const JOURNAL_SCHEMA = "workflow-v2-controlled-operation-journal-v1";
const RESERVATION_SCHEMA = "workflow-v2-controlled-operation-reservation-v1";
const SETTLEMENT_SCHEMA = "workflow-v2-controlled-operation-settlement-v1";
const MAX_JOURNAL_BYTES = 1024 * 1024;

export class WorkflowV2ControlledOperationJournalError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = "WorkflowV2ControlledOperationJournalError";
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new WorkflowV2ControlledOperationJournalError(message, code, details);
}

function assertPlainRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} is invalid`, "WORKFLOW_V2_CONTROLLED_OPERATION_JOURNAL_INVALID");
  }
  return value;
}

function durableWriteExclusive(pathname, bytes) {
  const fd = openSync(pathname, "wx", 0o600);
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function bestEffortSyncDirectory(directory) {
  let fd;
  try {
    fd = openSync(directory, "r");
    fsyncSync(fd);
  } catch {
    // Windows does not consistently allow opening directories for fsync. The
    // file itself was fsynced; directory syncing remains best-effort there.
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch {}
    }
  }
}

function readJsonFile(pathname, label) {
  let stat;
  try {
    stat = lstatSync(pathname);
  } catch (error) {
    fail(`${label} is missing`, "WORKFLOW_V2_CONTROLLED_OPERATION_AMBIGUOUS", {
      causeCode: String(error?.code || ""),
    });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 2 || stat.size > MAX_JOURNAL_BYTES) {
    fail(`${label} is not a bounded regular file`, "WORKFLOW_V2_CONTROLLED_OPERATION_AMBIGUOUS");
  }
  try {
    return assertPlainRecord(JSON.parse(readFileSync(pathname, "utf8")), label);
  } catch (error) {
    if (error instanceof WorkflowV2ControlledOperationJournalError) throw error;
    fail(`${label} is unreadable`, "WORKFLOW_V2_CONTROLLED_OPERATION_AMBIGUOUS", {
      causeCode: String(error?.code || ""),
    });
  }
}

function operationIdentity({ operationId, receiptId, operationArgsSha256 }) {
  if (typeof operationId !== "string" || !operationId
    || typeof receiptId !== "string" || !receiptId
    || !/^[a-f0-9]{64}$/.test(String(operationArgsSha256 || ""))) {
    fail("controlled operation identity is invalid", "WORKFLOW_V2_CONTROLLED_OPERATION_IDENTITY_INVALID");
  }
  const value = { operationId, receiptId, operationArgsSha256 };
  return Object.freeze({ ...value, identitySha256: canonicalSha256(value) });
}

/**
 * Story-local, append-safe boundary for externally visible controlled actions.
 * mkdir is the no-replace reservation primitive shared by every Gateway
 * process. A reservation without a valid settlement is deliberately never
 * stolen: the action may already have happened, so retry is ambiguous.
 */
export function createWorkflowV2ControlledOperationJournal({
  storyDirectory,
  validateTarget,
  now = () => new Date().toISOString(),
} = {}) {
  if (typeof storyDirectory !== "string" || !path.isAbsolute(storyDirectory)) {
    fail("controlled operation storyDirectory is invalid", "WORKFLOW_V2_CONTROLLED_OPERATION_JOURNAL_INVALID");
  }
  if (typeof validateTarget !== "function") {
    fail("controlled operation storage validator is unavailable", "WORKFLOW_V2_CONTROLLED_OPERATION_JOURNAL_INVALID");
  }
  const workflowDirectory = path.join(storyDirectory, "workflow-v2");
  const journalDirectory = path.join(workflowDirectory, "controlled-operations");

  function prepareJournalDirectory() {
    validateTarget(workflowDirectory, {
      baseDirectory: storyDirectory,
      createDirectory: true,
      expectedType: "directory",
    });
    validateTarget(journalDirectory, {
      baseDirectory: workflowDirectory,
      createDirectory: true,
      expectedType: "directory",
    });
  }

  function pathsFor(identity) {
    const directoryName = canonicalSha256({ operationId: identity.operationId });
    const operationDirectory = path.join(journalDirectory, directoryName);
    return {
      operationDirectory,
      reservationPath: path.join(operationDirectory, "reservation.json"),
      settlementPath: path.join(operationDirectory, "settlement.json"),
    };
  }

  function validateOperationDirectory(operationDirectory) {
    validateTarget(operationDirectory, {
      baseDirectory: journalDirectory,
      mustExist: true,
      expectedType: "directory",
    });
    const stat = lstatSync(operationDirectory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail("controlled operation reservation is not a plain directory", "WORKFLOW_V2_CONTROLLED_OPERATION_AMBIGUOUS");
    }
  }

  function readReservation(identity, paths) {
    validateTarget(paths.reservationPath, {
      baseDirectory: paths.operationDirectory,
      mustExist: true,
      expectedType: "file",
    });
    const reservation = readJsonFile(paths.reservationPath, "controlled operation reservation");
    if (reservation.schemaVersion !== RESERVATION_SCHEMA
      || reservation.journalSchemaVersion !== JOURNAL_SCHEMA
      || reservation.operationId !== identity.operationId
      || reservation.receiptId !== identity.receiptId
      || reservation.operationArgsSha256 !== identity.operationArgsSha256
      || reservation.identitySha256 !== identity.identitySha256
      || typeof reservation.ownerNonce !== "string" || !reservation.ownerNonce
      || !Number.isFinite(Date.parse(String(reservation.createdAt || "")))) {
      fail("controlled operation identity conflicts with its durable reservation", "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT", {
        operationId: identity.operationId,
      });
    }
    return reservation;
  }

  function readSettlement(identity, paths, reservation) {
    if (!existsSync(paths.settlementPath)) return null;
    validateTarget(paths.settlementPath, {
      baseDirectory: paths.operationDirectory,
      mustExist: true,
      expectedType: "file",
    });
    const settlement = readJsonFile(paths.settlementPath, "controlled operation settlement");
    const { settlementSha256, ...unsigned } = settlement;
    if (settlement.schemaVersion !== SETTLEMENT_SCHEMA
      || settlement.journalSchemaVersion !== JOURNAL_SCHEMA
      || settlement.operationId !== identity.operationId
      || settlement.receiptId !== identity.receiptId
      || settlement.operationArgsSha256 !== identity.operationArgsSha256
      || settlement.identitySha256 !== identity.identitySha256
      || settlement.ownerNonce !== reservation.ownerNonce
      || settlementSha256 !== canonicalSha256(unsigned)
      || canonicalSha256(settlement.operationArgs) !== identity.operationArgsSha256
      || !Number.isFinite(Date.parse(String(settlement.settledAt || "")))
      || settlement.payload?.operationId !== identity.operationId
      || settlement.payload?.receiptId !== identity.receiptId) {
      fail("controlled operation settlement is invalid", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID", {
        operationId: identity.operationId,
      });
    }
    return settlement;
  }

  function reserve({ operationId, receiptId, operationArgsSha256 }) {
    const identity = operationIdentity({ operationId, receiptId, operationArgsSha256 });
    prepareJournalDirectory();
    const paths = pathsFor(identity);
    validateTarget(paths.operationDirectory, {
      baseDirectory: journalDirectory,
      mustExist: false,
    });
    let created = false;
    try {
      mkdirSync(paths.operationDirectory, { recursive: false, mode: 0o700 });
      created = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    validateOperationDirectory(paths.operationDirectory);
    if (!created) {
      const reservation = readReservation(identity, paths);
      const settlement = readSettlement(identity, paths, reservation);
      if (settlement) return Object.freeze({ kind: "SETTLED", identity, paths, reservation, settlement });
      fail(
        "controlled operation has a durable reservation but no provable terminal settlement",
        "WORKFLOW_V2_CONTROLLED_OPERATION_AMBIGUOUS",
        { operationId },
      );
    }

    const reservation = {
      schemaVersion: RESERVATION_SCHEMA,
      journalSchemaVersion: JOURNAL_SCHEMA,
      operationId: identity.operationId,
      receiptId: identity.receiptId,
      operationArgsSha256: identity.operationArgsSha256,
      identitySha256: identity.identitySha256,
      ownerNonce: randomUUID(),
      createdAt: now(),
    };
    durableWriteExclusive(paths.reservationPath, `${JSON.stringify(reservation)}\n`);
    bestEffortSyncDirectory(paths.operationDirectory);
    return Object.freeze({ kind: "RESERVED", identity, paths, reservation: Object.freeze(reservation), settlement: null });
  }

  function settle(handle, { payload, operationArgs, output = "" } = {}) {
    if (handle?.kind !== "RESERVED") {
      fail("only the reservation owner may settle a controlled operation", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
    }
    assertPlainRecord(payload, "controlled operation receipt payload");
    assertPlainRecord(operationArgs, "controlled operation arguments");
    if (canonicalSha256(operationArgs) !== handle.identity.operationArgsSha256) {
      fail(
        "controlled operation arguments differ from the durable reservation",
        "WORKFLOW_V2_RECEIPT_OPERATION_CONFLICT",
        { operationId: handle.identity.operationId },
      );
    }
    const existing = readSettlement(handle.identity, handle.paths, handle.reservation);
    if (existing) return existing;
    const unsigned = {
      schemaVersion: SETTLEMENT_SCHEMA,
      journalSchemaVersion: JOURNAL_SCHEMA,
      operationId: handle.identity.operationId,
      receiptId: handle.identity.receiptId,
      operationArgsSha256: handle.identity.operationArgsSha256,
      identitySha256: handle.identity.identitySha256,
      ownerNonce: handle.reservation.ownerNonce,
      settledAt: now(),
      payload,
      operationArgs,
      output: String(output || ""),
    };
    const settlement = { ...unsigned, settlementSha256: canonicalSha256(unsigned) };
    const temporaryPath = path.join(handle.paths.operationDirectory, `.settlement-${handle.reservation.ownerNonce}.tmp`);
    validateTarget(temporaryPath, {
      baseDirectory: handle.paths.operationDirectory,
      mustExist: false,
    });
    durableWriteExclusive(temporaryPath, `${JSON.stringify(settlement)}\n`);
    if (existsSync(handle.paths.settlementPath)) {
      fail("controlled operation settlement already exists", "WORKFLOW_V2_CONTROLLED_OPERATION_SETTLEMENT_INVALID");
    }
    renameSync(temporaryPath, handle.paths.settlementPath);
    bestEffortSyncDirectory(handle.paths.operationDirectory);
    return readSettlement(handle.identity, handle.paths, handle.reservation);
  }

  return Object.freeze({ reserve, settle });
}
