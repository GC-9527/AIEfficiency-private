import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import * as defaultPersistence from "../../../db/sqlite.js";
import {
  GitControllerError,
  canonicalizeManagedPath,
  ensureManagedDirectory,
} from "./path-security.js";

const WINDOWS_POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

export function pidIsAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return false;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function processStartIdentity(pid = process.pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    if (process.platform === "linux") {
      const stat = fs.readFileSync(`/proc/${numericPid}/stat`, "utf8").trim();
      // comm (field 2) is parenthesized and may itself contain whitespace or
      // parentheses, so splitting the entire line can shift field 22.
      const commEnd = stat.lastIndexOf(")");
      if (commEnd <= 0) return null;
      const fieldsAfterComm = stat.slice(commEnd + 1).trim().split(/\s+/);
      const startTime = fieldsAfterComm[19]; // field 22; this array starts at field 3
      return /^\d+$/.test(startTime || "") ? `linux-start:${startTime}` : null;
    }
    if (process.platform === "win32") {
      const output = execFileSync(
        WINDOWS_POWERSHELL,
        [
          "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
          `(Get-Process -Id ${numericPid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`,
        ],
        { encoding: "utf8", windowsHide: true, timeout: 5_000 },
      ).trim();
      return /^\d+$/.test(output) ? `windows-start:${output}` : null;
    }
    if (process.platform === "darwin") {
      const output = execFileSync(
        "/bin/ps",
        ["-o", "lstart=", "-p", String(numericPid)],
        { encoding: "utf8", timeout: 5_000 },
      ).trim().replace(/\s+/g, " ");
      return output
        ? `macos-start:${createHash("sha256").update(output).digest("hex")}`
        : null;
    }
  } catch {}
  return pidIsAlive(numericPid) ? `alive-unbound:${numericPid}` : null;
}

export function isTrustedProcessStartIdentity(value) {
  return /^(?:linux|windows|macos)-start:[A-Za-z0-9]+$/.test(String(value || ""));
}

function readLockFile(lockPath) {
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function writeLockFile(lockPath, payload, flags = "wx") {
  const descriptor = fs.openSync(lockPath, flags, 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(payload)}\n`, { encoding: "utf8" });
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameLock(left, right) {
  return left
    && right
    && left.repositoryId === right.repositoryId
    && left.leaseId === right.leaseId
    && Number(left.fencingToken) === Number(right.fencingToken);
}

function normalizedGitChildren(lock) {
  const children = lock?.gitChildren;
  if (
    !children
    || typeof children !== "object"
    || Array.isArray(children)
  ) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(children)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([executionId, child]) => [executionId, child]),
  );
}

function normalizedProcessContainment(lock) {
  const containment = lock?.processContainment;
  if (containment == null) return null;
  if (
    typeof containment !== "object"
    || Array.isArray(containment)
    || Number(containment.schemaVersion) !== 2
    || !["win32", "linux"].includes(containment.platform)
    || ![
      "WINDOWS_JOB_KILL_ON_CLOSE",
      "LINUX_CGROUP_V2_SUPERVISED",
    ].includes(containment.mode)
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(
      String(containment.containerPolicyId || ""),
    )
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(
      String(containment.containerEpoch || ""),
    )
    || !/^[0-9a-f]{64}$/.test(String(containment.policyDigest || ""))
    || !/^[0-9a-f]{64}$/.test(String(containment.guardianKeyId || ""))
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      String(containment.daemonInstanceId || ""),
    )
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: 2,
    platform: containment.platform,
    mode: containment.mode,
    daemonInstanceId: containment.daemonInstanceId,
    containerPolicyId: containment.containerPolicyId,
    containerEpoch: containment.containerEpoch,
    policyDigest: containment.policyDigest,
    guardianKeyId: containment.guardianKeyId,
  });
}

function sameGuardedLock(left, right) {
  if (!sameLock(left, right)) return false;
  if (
    Number(left?.schemaVersion) !== 2
    || Number(right?.schemaVersion) !== 2
    || Number(left?.lockRevision) !== Number(right?.lockRevision)
  ) {
    return false;
  }
  const leftChildren = normalizedGitChildren(left);
  const rightChildren = normalizedGitChildren(right);
  const leftContainment = normalizedProcessContainment(left);
  const rightContainment = normalizedProcessContainment(right);
  return !!(
    leftChildren
    && rightChildren
    && JSON.stringify(leftChildren) === JSON.stringify(rightChildren)
    && JSON.stringify(leftContainment) === JSON.stringify(rightContainment)
  );
}

function gitChildCount(lock) {
  return Object.keys(normalizedGitChildren(lock) || {}).length;
}

export class RepositoryLease {
  constructor({
    manager,
    repository,
    operationId,
    kind,
    lease,
    lockPath,
    lockPayload,
    recoveredLock = null,
  }) {
    this.manager = manager;
    this.repository = repository;
    this.operationId = operationId;
    this.kind = kind;
    this.leaseId = lease.leaseId;
    this.fencingToken = lease.fencingToken;
    this.expiresAt = lease.expiresAt;
    this.lockPath = lockPath;
    this.lockPayload = lockPayload;
    this.recoveredLock = recoveredLock;
    this.released = false;
    this.lost = false;
    this.heartbeatTimer = setInterval(() => {
      try {
        this.heartbeat();
      } catch {
        this.lost = true;
      }
    }, Math.max(1000, Math.floor(this.manager.ttlMs / 3)));
    this.heartbeatTimer.unref?.();
  }

  assertCurrent() {
    if (this.released || this.lost) {
      throw new GitControllerError(
        "GIT_CONTROLLER_LEASE_LOST",
        "Repository lease is no longer current",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
      );
    }
    const current = this.manager.persistence.assertGitControllerRepositoryLease({
      repositoryId: this.repository.repositoryId,
      leaseId: this.leaseId,
      ownerInstance: this.manager.ownerInstance,
      fencingToken: this.fencingToken,
      now: Date.now(),
    });
    const onDisk = readLockFile(this.lockPath);
    if (!current?.ok || !sameGuardedLock(onDisk, this.lockPayload)) {
      this.lost = true;
      throw new GitControllerError(
        "GIT_CONTROLLER_LEASE_LOST",
        "Repository lease or fencing token changed",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
      );
    }
    return current.lease;
  }

  writeGitChildren(nextChildren, {
    requireCurrentLease = false,
  } = {}) {
    if (this.released) {
      throw new GitControllerError(
        "GIT_CONTROLLER_LEASE_LOST",
        "Repository lease is no longer current",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
      );
    }
    if (requireCurrentLease) this.assertCurrent();
    const current = readLockFile(this.lockPath);
    if (!sameGuardedLock(current, this.lockPayload)) {
      this.lost = true;
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_CHANGED",
        "Repository OS lock changed while tracking a Git child process",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
      );
    }
    const nextPayload = {
      ...this.lockPayload,
      lockRevision: Number(this.lockPayload.lockRevision) + 1,
      gitChildren: Object.fromEntries(
        Object.entries(nextChildren || {})
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    };
    try {
      writeLockFile(this.lockPath, nextPayload, "w");
    } catch (error) {
      this.lost = true;
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_WRITE_FAILED",
        "Repository OS lock Git-child ledger could not be persisted",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
        { cause: error },
      );
    }
    const verified = readLockFile(this.lockPath);
    if (!sameGuardedLock(verified, nextPayload)) {
      this.lost = true;
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_WRITE_FAILED",
        "Repository OS lock Git-child ledger could not be verified",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
      );
    }
    this.lockPayload = nextPayload;
    return normalizedGitChildren(nextPayload);
  }

  beginGitSpawn(commandIdValue) {
    const commandId = String(commandIdValue || "").trim();
    if (!commandId || commandId.length > 256) {
      throw new GitControllerError(
        "GIT_CONTROLLER_GIT_CHILD_COMMAND_INVALID",
        "Tracked Git child requires a bounded command identifier",
      );
    }
    this.manager.processContainmentAssertLive?.();
    // This renews and proves both the SQLite fence and exact v2 OS lock before
    // any child can be created.
    this.heartbeat();
    const children = normalizedGitChildren(this.lockPayload);
    if (!children || Object.keys(children).length > 0) {
      throw new GitControllerError(
        "GIT_CONTROLLER_GIT_CHILD_CONFLICT",
        "Repository lease already tracks an unfinished Git child process",
        { repositoryId: this.repository.repositoryId },
      );
    }
    const executionId = randomUUID();
    this.writeGitChildren({
      [executionId]: {
        executionId,
        commandId,
        state: "SPAWNING",
        pid: null,
        processStartIdentity: null,
        startedAt: Date.now(),
      },
    });
    return executionId;
  }

  markGitChildSpawned(executionIdValue, pidValue) {
    const executionId = String(executionIdValue || "").trim();
    const pid = Number(pidValue);
    if (!executionId || !Number.isInteger(pid) || pid <= 0) {
      throw new GitControllerError(
        "GIT_CONTROLLER_GIT_CHILD_IDENTITY_INVALID",
        "Spawned Git child does not have a valid execution id and PID",
      );
    }
    const children = normalizedGitChildren(this.lockPayload) || {};
    const current = children[executionId];
    if (current?.state !== "SPAWNING") {
      throw new GitControllerError(
        "GIT_CONTROLLER_GIT_CHILD_STATE_INVALID",
        "Git child is not in the expected pre-spawn ledger state",
        { repositoryId: this.repository.repositoryId, executionId },
      );
    }
    // A very short Git command may exit before its start identity can be
    // queried. Null remains safe: recovery treats a live PID with missing or
    // untrusted identity as unverifiable and therefore refuses lock takeover.
    const processStartIdentity = pidIsAlive(pid)
      ? this.manager.processIdentityProbe(pid)
      : null;
    this.writeGitChildren({
      ...children,
      [executionId]: {
        ...current,
        state: "RUNNING",
        pid,
        processStartIdentity: isTrustedProcessStartIdentity(processStartIdentity)
          ? processStartIdentity
          : null,
        spawnedAt: Date.now(),
      },
    });
    return Object.freeze({
      executionId,
      pid,
      processStartIdentity: isTrustedProcessStartIdentity(processStartIdentity)
        ? processStartIdentity
        : null,
    });
  }

  finishGitChild(executionIdValue, pidValue = null) {
    const executionId = String(executionIdValue || "").trim();
    const pid = pidValue == null ? null : Number(pidValue);
    const children = normalizedGitChildren(this.lockPayload) || {};
    const current = children[executionId];
    if (!current) return { ok: true, replayed: true };
    if (
      current.state === "RUNNING"
      && (
        !Number.isInteger(pid)
        || pid <= 0
        || Number(current.pid) !== pid
      )
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_GIT_CHILD_IDENTITY_INVALID",
        "Git child close event does not match the tracked PID",
        { repositoryId: this.repository.repositoryId, executionId },
      );
    }
    const next = { ...children };
    delete next[executionId];
    // Do not require the SQLite lease here. A competing claim may have
    // advanced the fence and then failed on this still-owned OS lock. The old
    // owner must still be able to record that its exact child exited; the
    // exact lease/fence/revision check in writeGitChildren prevents it from
    // touching a replacement lock.
    this.writeGitChildren(next);
    return { ok: true, replayed: false };
  }

  gitChildGuard(commandId) {
    let executionId = null;
    let pid = null;
    return Object.freeze({
      beforeSpawn: () => {
        executionId = this.beginGitSpawn(commandId);
        return executionId;
      },
      afterSpawn: (ticket, child = {}) => {
        if (!executionId || ticket !== executionId) {
          throw new GitControllerError(
            "GIT_CONTROLLER_GIT_CHILD_TICKET_INVALID",
            "Git child spawn ticket does not match the repository lease",
          );
        }
        pid = Number(child.pid);
        return this.markGitChildSpawned(executionId, pid);
      },
      afterClose: (ticket, child = {}) => {
        if (!executionId || ticket !== executionId) {
          throw new GitControllerError(
            "GIT_CONTROLLER_GIT_CHILD_TICKET_INVALID",
            "Git child close ticket does not match the repository lease",
          );
        }
        const closedPid = child.pid == null ? pid : Number(child.pid);
        const result = this.finishGitChild(executionId, closedPid);
        executionId = null;
        pid = null;
        return result;
      },
      spawnFailed: (ticket) => {
        if (!executionId || ticket !== executionId) {
          throw new GitControllerError(
            "GIT_CONTROLLER_GIT_CHILD_TICKET_INVALID",
            "Git child failure ticket does not match the repository lease",
          );
        }
        const result = this.finishGitChild(executionId, null);
        executionId = null;
        pid = null;
        return result;
      },
    });
  }

  heartbeat() {
    this.assertCurrent();
    const renewed = this.manager.persistence.renewGitControllerRepositoryLease({
      repositoryId: this.repository.repositoryId,
      leaseId: this.leaseId,
      ownerInstance: this.manager.ownerInstance,
      fencingToken: this.fencingToken,
      now: Date.now(),
      ttlMs: this.manager.ttlMs,
    });
    if (!renewed?.ok) {
      this.lost = true;
      throw new GitControllerError(
        "GIT_CONTROLLER_LEASE_LOST",
        "Repository lease heartbeat failed",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
      );
    }
    const current = readLockFile(this.lockPath);
    if (!sameGuardedLock(current, this.lockPayload)) {
      this.lost = true;
      throw new GitControllerError(
        "GIT_CONTROLLER_LEASE_LOST",
        "Repository OS lock changed during heartbeat",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
      );
    }
    const nextPayload = {
      ...this.lockPayload,
      lockRevision: Number(this.lockPayload.lockRevision) + 1,
      expiresAt: renewed.expiresAt,
      heartbeatAt: Date.now(),
    };
    try {
      writeLockFile(this.lockPath, nextPayload, "w");
    } catch (error) {
      this.lost = true;
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_WRITE_FAILED",
        "Repository OS lock heartbeat could not be persisted",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
        { cause: error },
      );
    }
    const verified = readLockFile(this.lockPath);
    if (!sameGuardedLock(verified, nextPayload)) {
      this.lost = true;
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_WRITE_FAILED",
        "Repository OS lock heartbeat could not be verified",
        { repositoryId: this.repository.repositoryId, fencingToken: this.fencingToken },
      );
    }
    this.lockPayload = nextPayload;
    this.expiresAt = renewed.expiresAt;
    return this.expiresAt;
  }

  release() {
    if (this.released) return { ok: true, replay: true };
    clearInterval(this.heartbeatTimer);
    let lockRemoved = false;
    const current = readLockFile(this.lockPath);
    const childGuarded = gitChildCount(this.lockPayload) > 0;
    if (!childGuarded && sameGuardedLock(current, this.lockPayload)) {
      try {
        fs.unlinkSync(this.lockPath);
        lockRemoved = true;
      } catch {}
    }
    const released = this.manager.persistence.releaseGitControllerRepositoryLease({
      repositoryId: this.repository.repositoryId,
      leaseId: this.leaseId,
      ownerInstance: this.manager.ownerInstance,
      fencingToken: this.fencingToken,
    });
    this.released = true;
    return {
      ok: released?.ok === true && lockRemoved,
      dbReleased: released?.ok === true,
      lockRemoved,
      childGuarded,
    };
  }
}

export class RepositoryLeaseManager {
  constructor({
    dataRoot,
    persistence = defaultPersistence,
    ownerInstance = `${os.hostname()}:${process.pid}:${randomUUID()}`,
    ttlMs = 30_000,
    processIdentityProbe = processStartIdentity,
    processContainment = null,
    processTreeRecoveryProbe = null,
    processContainmentAssertLive = null,
  } = {}) {
    this.dataRoot = String(dataRoot || "");
    this.persistence = persistence;
    this.ownerInstance = String(ownerInstance || "").trim();
    this.ttlMs = Math.max(5000, Number(ttlMs) || 30_000);
    this.processIdentityProbe = processIdentityProbe;
    this.processContainment = processContainment == null
      ? null
      : normalizedProcessContainment({ processContainment });
    this.processTreeRecoveryProbe = processTreeRecoveryProbe;
    this.processContainmentAssertLive = processContainmentAssertLive;
    if (!this.ownerInstance) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OWNER_REQUIRED",
        "Controller owner identity is required",
      );
    }
    if (
      (processContainment != null && !this.processContainment)
      || (
        this.processContainment
        && (
          typeof processTreeRecoveryProbe !== "function"
          || typeof processContainmentAssertLive !== "function"
        )
      )
      || (
        !this.processContainment
        && (
          processTreeRecoveryProbe != null
          || processContainmentAssertLive != null
        )
      )
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_PROCESS_TREE_CONTAINMENT_INVALID",
        "Repository leases require matching native containment identity, liveness, and recovery probes",
      );
    }
  }

  assertNoLiveGitChildren(repository, lock, {
    operationId = null,
  } = {}) {
    if (!lock) return Object.freeze([]);
    if (
      Number(lock.schemaVersion) !== 2
      || !Number.isSafeInteger(Number(lock.lockRevision))
      || Number(lock.lockRevision) < 1
      || !normalizedGitChildren(lock)
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_CHILD_LEDGER_UNVERIFIED",
        "Repository OS lock predates or violates the Git-child recovery ledger",
        {
          recoveryRequired: true,
          repositoryId: repository.repositoryId,
          operationId,
        },
      );
    }
    const evidence = [];
    for (const [executionId, child] of Object.entries(normalizedGitChildren(lock))) {
      if (
        !child
        || typeof child !== "object"
        || child.executionId !== executionId
        || !String(child.commandId || "").trim()
        || !["SPAWNING", "RUNNING"].includes(child.state)
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_OS_LOCK_CHILD_LEDGER_UNVERIFIED",
          "Repository OS lock contains an invalid Git-child recovery record",
          {
            recoveryRequired: true,
            repositoryId: repository.repositoryId,
            operationId,
            executionId,
          },
        );
      }
      if (child.state === "SPAWNING") {
        throw new GitControllerError(
          "GIT_CONTROLLER_OS_LOCK_GIT_CHILD_UNCERTAIN",
          "Controller stopped while a Git child spawn was in progress",
          {
            recoveryRequired: true,
            repositoryId: repository.repositoryId,
            operationId,
            executionId,
            commandId: child.commandId,
          },
        );
      }
      const childPid = Number(child.pid);
      if (!Number.isInteger(childPid) || childPid <= 0) {
        throw new GitControllerError(
          "GIT_CONTROLLER_OS_LOCK_CHILD_LEDGER_UNVERIFIED",
          "Repository OS lock contains a running Git child without a valid PID",
          {
            recoveryRequired: true,
            repositoryId: repository.repositoryId,
            operationId,
            executionId,
          },
        );
      }
      const childPidAlive = pidIsAlive(childPid);
      const observedProcessStartIdentity = childPidAlive
        ? this.processIdentityProbe(childPid)
        : null;
      const recordedProcessStartIdentity = String(
        child.processStartIdentity || "",
      ).trim();
      const sameChildProcess = !!(
        childPidAlive
        && isTrustedProcessStartIdentity(recordedProcessStartIdentity)
        && observedProcessStartIdentity === recordedProcessStartIdentity
      );
      const provenPidReuse = !!(
        childPidAlive
        && isTrustedProcessStartIdentity(recordedProcessStartIdentity)
        && isTrustedProcessStartIdentity(observedProcessStartIdentity)
        && observedProcessStartIdentity !== recordedProcessStartIdentity
      );
      if (sameChildProcess) {
        throw new GitControllerError(
          "GIT_CONTROLLER_OS_LOCK_GIT_CHILD_ACTIVE",
          "A Git child from the previous Controller owner is still running",
          {
            recoveryRequired: true,
            repositoryId: repository.repositoryId,
            operationId,
            executionId,
            commandId: child.commandId,
            childPid,
          },
        );
      }
      if (childPidAlive && !provenPidReuse) {
        throw new GitControllerError(
          "GIT_CONTROLLER_OS_LOCK_GIT_CHILD_UNVERIFIED",
          "A live PID cannot be proven different from the previous Controller Git child",
          {
            recoveryRequired: true,
            repositoryId: repository.repositoryId,
            operationId,
            executionId,
            commandId: child.commandId,
            childPid,
            recordedProcessStartIdentity: recordedProcessStartIdentity || null,
            observedProcessStartIdentity,
          },
        );
      }
      evidence.push(Object.freeze({
        executionId,
        commandId: child.commandId,
        childPid,
        recordedProcessStartIdentity: recordedProcessStartIdentity || null,
        observedProcessStartIdentity,
        childPidAlive,
        provenPidReuse,
      }));
    }
    const current = readLockFile(repository.lockPath);
    if (!sameGuardedLock(current, lock)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_CHANGED",
        "Repository OS lock changed while Git-child recovery was being proven",
        {
          recoveryRequired: true,
          repositoryId: repository.repositoryId,
          operationId,
        },
      );
    }
    const containment = normalizedProcessContainment(lock);
    const requiresNativeTreeProof = !!(
      this.processContainment
      || containment
      || evidence.length
    );
    if (requiresNativeTreeProof) {
      if (
        !containment
        || !this.processContainment
        || typeof this.processTreeRecoveryProbe !== "function"
        || containment.platform !== this.processContainment?.platform
        || containment.mode !== this.processContainment?.mode
        || containment.containerPolicyId
          !== this.processContainment?.containerPolicyId
        || containment.policyDigest !== this.processContainment?.policyDigest
        || containment.guardianKeyId !== this.processContainment?.guardianKeyId
        || containment.containerEpoch
          === this.processContainment?.containerEpoch
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PROCESS_TREE_RECOVERY_UNVERIFIED",
          "A stale repository lock requires guardian proof that its prior process-tree container was sealed and emptied",
          {
            recoveryRequired: true,
            repositoryId: repository.repositoryId,
            operationId,
          },
        );
      }
      const treeProof = this.processTreeRecoveryProbe({
        repositoryId: repository.repositoryId,
        operationId,
        lockRevision: Number(lock.lockRevision),
        containerEpoch: containment.containerEpoch,
        gitChildren: evidence,
      });
      if (
        !treeProof
        || treeProof.ok !== true
        || treeProof.containerSealed !== true
        || treeProof.containerClosed !== true
        || Number(treeProof.activeProcessCount) !== 0
        || treeProof.containerEpoch !== containment.containerEpoch
        || treeProof.currentContainerEpoch
          !== this.processContainment.containerEpoch
      ) {
        throw new GitControllerError(
          "GIT_CONTROLLER_PROCESS_TREE_RECOVERY_UNVERIFIED",
          "Native proof did not confirm that the prior Git process-tree container is empty",
          {
            recoveryRequired: true,
            repositoryId: repository.repositoryId,
            operationId,
          },
        );
      }
      Object.defineProperty(evidence, "processTreeProof", {
        configurable: false,
        enumerable: false,
        writable: false,
        value: Object.freeze({
          processTreeContainerEpoch: containment.containerEpoch,
          processTreeContainerSealed: true,
          processTreeContainerClosed: true,
          processTreeActiveProcessCount: 0,
          tombstoneId: treeProof.tombstoneId || null,
        }),
      });
    }
    const afterTreeProof = readLockFile(repository.lockPath);
    if (!sameGuardedLock(afterTreeProof, lock)) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_CHANGED",
        "Repository OS lock changed while native process-tree recovery was being proven",
        {
          recoveryRequired: true,
          repositoryId: repository.repositoryId,
          operationId,
        },
      );
    }
    return Object.freeze(evidence);
  }

  inspectOperationOwner(repository, operation) {
    if (
      !repository?.repositoryId
      || !repository?.lockPath
      || !operation?.operationId
      || operation.repositoryId !== repository.repositoryId
      || !String(operation.ownerInstance || "").trim()
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OPERATION_RECOVERY_IDENTITY_INVALID",
        "Recoverable operation does not have a valid repository and owner binding",
        {
          recoveryRequired: true,
          operationId: String(operation?.operationId || ""),
          repositoryId: String(operation?.repositoryId || ""),
        },
      );
    }
    const lease = this.persistence.getGitControllerRepositoryLease(
      repository.repositoryId,
    );
    const lockExists = fs.existsSync(repository.lockPath);
    const lock = readLockFile(repository.lockPath);
    if (lockExists && !lock) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OPERATION_RECOVERY_LOCK_INVALID",
        "Recoverable operation lock exists but cannot be verified",
        {
          recoveryRequired: true,
          operationId: operation.operationId,
          repositoryId: repository.repositoryId,
        },
      );
    }
    if (
      lease
      && (
        lease.operationId !== operation.operationId
        || lease.ownerInstance !== operation.ownerInstance
      )
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OPERATION_RECOVERY_LEASE_CONFLICT",
        "Repository lease belongs to a different operation or owner",
        {
          recoveryRequired: true,
          operationId: operation.operationId,
          repositoryId: repository.repositoryId,
          leaseOperationId: lease.operationId,
        },
      );
    }
    if (
      lock
      && (
        lock.repositoryId !== repository.repositoryId
        || lock.operationId !== operation.operationId
        || lock.ownerInstance !== operation.ownerInstance
        || (
          lease
          && (
            lock.leaseId !== lease.leaseId
            || Number(lock.fencingToken) !== Number(lease.fencingToken)
          )
        )
      )
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OPERATION_RECOVERY_LOCK_CONFLICT",
        "Repository OS lock does not match the recoverable operation lease",
        {
          recoveryRequired: true,
          operationId: operation.operationId,
          repositoryId: repository.repositoryId,
        },
      );
    }
    const ownerHostname = String(
      operation.ownerHostname || lease?.ownerHostname || lock?.hostname || "",
    ).trim();
    const ownerPid = Number(
      operation.ownerPid || lease?.ownerPid || lock?.ownerPid || 0,
    );
    const ownerProcessStartIdentity = String(
      operation.ownerProcessStartIdentity
      || lease?.ownerProcessStartIdentity
      || lock?.ownerProcessStartIdentity
      || "",
    ).trim();
    const ownerFields = [
      ["hostname", operation.ownerHostname, lease?.ownerHostname, lock?.hostname],
      ["pid", operation.ownerPid, lease?.ownerPid, lock?.ownerPid],
      [
        "processStartIdentity",
        operation.ownerProcessStartIdentity,
        lease?.ownerProcessStartIdentity,
        lock?.ownerProcessStartIdentity,
      ],
    ];
    for (const [field, ...values] of ownerFields) {
      const normalized = values
        .filter((value) => value != null && String(value).trim() !== "")
        .map((value) => field === "pid" ? String(Number(value)) : String(value));
      if (new Set(normalized).size > 1) {
        throw new GitControllerError(
          "GIT_CONTROLLER_OPERATION_RECOVERY_IDENTITY_CONFLICT",
          "Operation, repository lease and OS lock owner identities disagree",
          {
            recoveryRequired: true,
            operationId: operation.operationId,
            repositoryId: repository.repositoryId,
            field,
          },
        );
      }
    }
    if (
      !ownerHostname
      || !Number.isInteger(ownerPid)
      || ownerPid <= 0
      || !ownerProcessStartIdentity
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OPERATION_RECOVERY_IDENTITY_MISSING",
        "Operation owner PID and process-start identity are required for recovery",
        {
          recoveryRequired: true,
          operationId: operation.operationId,
          repositoryId: repository.repositoryId,
        },
      );
    }
    if (ownerHostname !== os.hostname()) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OPERATION_RECOVERY_REMOTE_OWNER",
        "Operation owner belongs to another host and cannot be proven stopped",
        {
          recoveryRequired: true,
          operationId: operation.operationId,
          repositoryId: repository.repositoryId,
          ownerHostname,
        },
      );
    }
    const observedProcessStartIdentity = this.processIdentityProbe(ownerPid);
    const ownerPidAlive = pidIsAlive(ownerPid);
    const sameOwnerProcess = !!(
      ownerPidAlive
      && isTrustedProcessStartIdentity(ownerProcessStartIdentity)
      && observedProcessStartIdentity === ownerProcessStartIdentity
    );
    const provenPidReuse = !!(
      ownerPidAlive
      && isTrustedProcessStartIdentity(observedProcessStartIdentity)
      && isTrustedProcessStartIdentity(ownerProcessStartIdentity)
      && observedProcessStartIdentity !== ownerProcessStartIdentity
    );
    if (sameOwnerProcess) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OPERATION_OWNER_ACTIVE",
        "Recoverable operation still belongs to a live Controller process",
        {
          recoveryRequired: true,
          operationId: operation.operationId,
          repositoryId: repository.repositoryId,
          ownerPid,
          ownerProcessStartIdentity,
        },
      );
    }
    if (ownerPidAlive && !provenPidReuse) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OPERATION_OWNER_UNVERIFIED",
        "Controller process identity cannot safely prove the operation owner stopped",
        {
          recoveryRequired: true,
          operationId: operation.operationId,
          repositoryId: repository.repositoryId,
          ownerPid,
          ownerProcessStartIdentity,
          observedProcessStartIdentity,
        },
      );
    }
    const gitChildren = this.assertNoLiveGitChildren(repository, lock, {
      operationId: operation.operationId,
    });
    return Object.freeze({
      orphaned: true,
      ownerHostname,
      ownerPid,
      ownerProcessStartIdentity,
      observedProcessStartIdentity,
      ownerPidAlive,
      provenPidReuse,
      lease,
      lock,
      gitChildren,
    });
  }

  reclaimOrphanedOperation(repository, operation) {
    const evidence = this.inspectOperationOwner(repository, operation);
    let staleLockPath = null;
    if (evidence.lock) {
      const current = readLockFile(repository.lockPath);
      if (!sameGuardedLock(current, evidence.lock)) {
        throw new GitControllerError(
          "GIT_CONTROLLER_OPERATION_RECOVERY_LOCK_CHANGED",
          "Repository OS lock changed while orphan recovery was in progress",
          {
            recoveryRequired: true,
            operationId: operation.operationId,
            repositoryId: repository.repositoryId,
          },
        );
      }
      staleLockPath = `${repository.lockPath}.stale.recovery.${Date.now()}.${randomUUID()}`;
      fs.renameSync(repository.lockPath, staleLockPath);
    }
    if (evidence.lease) {
      const released = this.persistence.releaseOrphanedGitControllerRepositoryLease({
        repositoryId: repository.repositoryId,
        leaseId: evidence.lease.leaseId,
        operationId: operation.operationId,
        ownerInstance: operation.ownerInstance,
        ownerPid: evidence.ownerPid,
        fencingToken: evidence.lease.fencingToken,
      });
      if (!released?.ok) {
        const current = this.persistence.getGitControllerRepositoryLease(
          repository.repositoryId,
        );
        if (current) {
          throw new GitControllerError(
            "GIT_CONTROLLER_OPERATION_RECOVERY_LEASE_CHANGED",
            "Repository lease changed while orphan recovery was in progress",
            {
              recoveryRequired: true,
              operationId: operation.operationId,
              repositoryId: repository.repositoryId,
              leaseOperationId: current.operationId,
            },
          );
        }
      }
    }
    const auditRow = {
      auditId: randomUUID(),
      operationId: operation.operationId,
      repositoryId: repository.repositoryId,
      commandId: "git-controller.operation.recover-orphan",
      action: "git-controller.operation.recover-orphan",
      result: "PASS",
      reason: evidence.provenPidReuse
        ? "owner_pid_reused"
        : "owner_process_stopped",
      fencingToken: evidence.lease?.fencingToken || operation.fencingToken || null,
      actor: this.ownerInstance,
      details: {
        previousOwnerInstance: operation.ownerInstance,
        previousOwnerPid: evidence.ownerPid,
        previousOwnerProcessStartIdentity: evidence.ownerProcessStartIdentity,
        observedOwnerProcessStartIdentity: evidence.observedProcessStartIdentity,
        staleLockFile: staleLockPath ? path.basename(staleLockPath) : null,
        verifiedStoppedGitChildren: evidence.gitChildren?.length || 0,
        processTreeProof: evidence.gitChildren?.processTreeProof || null,
        operationType: operation.operationType || null,
        operationCommandId: operation.commandId || null,
      },
      createdAt: Date.now(),
    };
    if (typeof this.persistence.appendGitControllerAuditOnce === "function") {
      const appended = this.persistence.appendGitControllerAuditOnce(auditRow);
      if (!appended?.ok) {
        throw new GitControllerError(
          "GIT_CONTROLLER_OPERATION_RECOVERY_AUDIT_FAILED",
          "Orphaned Controller operation recovery audit could not be persisted",
          {
            recoveryRequired: true,
            operationId: operation.operationId,
            repositoryId: repository.repositoryId,
            reason: appended?.reason || "audit_failed",
          },
        );
      }
    } else {
      this.persistence.appendGitControllerAudit(auditRow);
    }
    return Object.freeze({
      ...evidence,
      staleLockPath,
    });
  }

  recoverStaleLock(repository, lockPath, claimed, now) {
    const lock = readLockFile(lockPath);
    if (!lock) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_CONFLICT",
        "Repository OS lock exists but cannot be verified",
        { repositoryId: repository.repositoryId },
      );
    }
    const sameHost = String(lock.hostname || "") === os.hostname();
    const expired = Number(lock.expiresAt || 0) <= now;
    const superseded = Number(lock.fencingToken || 0) < Number(claimed.lease.fencingToken);
    const liveStartIdentity = sameHost
      ? this.processIdentityProbe(lock.ownerPid)
      : null;
    const ownerPidAlive = sameHost ? pidIsAlive(lock.ownerPid) : true;
    const sameOwnerProcess = !!(
      liveStartIdentity
      && lock.ownerProcessStartIdentity
      && liveStartIdentity === lock.ownerProcessStartIdentity
    );
    const provenPidReuse = (
      isTrustedProcessStartIdentity(liveStartIdentity)
      && isTrustedProcessStartIdentity(lock.ownerProcessStartIdentity)
      && liveStartIdentity !== lock.ownerProcessStartIdentity
    );
    const ownerProvenGone = !ownerPidAlive;
    if (
      !expired
      || !superseded
      || !sameHost
      || sameOwnerProcess
      || (!ownerProvenGone && !provenPidReuse)
    ) {
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_CONFLICT",
        "Repository OS lock is still active or belongs to another host",
        {
          repositoryId: repository.repositoryId,
          lockFencingToken: Number(lock.fencingToken || 0),
        },
      );
    }
    const gitChildren = this.assertNoLiveGitChildren(
      { ...repository, lockPath },
      lock,
      { operationId: claimed.lease.operationId },
    );
    const stalePath = `${lockPath}.stale.${now}.${randomUUID()}`;
    fs.renameSync(lockPath, stalePath);
    this.persistence.appendGitControllerAudit({
      auditId: randomUUID(),
      operationId: claimed.lease.operationId,
      repositoryId: repository.repositoryId,
      commandId: "repository.lease.recover",
      action: "repository.lease.recover",
      result: "PASS",
      reason: "expired_os_lock_recovered",
      fencingToken: claimed.lease.fencingToken,
      actor: this.ownerInstance,
      details: {
        previousLeaseId: lock.leaseId || null,
        previousFencingToken: Number(lock.fencingToken || 0),
        previousOwnerProcessStartIdentity: lock.ownerProcessStartIdentity || null,
        observedOwnerProcessStartIdentity: liveStartIdentity,
        verifiedStoppedGitChildren: gitChildren.length,
        processTreeProof: gitChildren.processTreeProof || null,
        staleFile: path.basename(stalePath),
      },
      createdAt: now,
    });
    return { ...lock, stalePath };
  }

  acquire(repository, { operationId, kind } = {}) {
    if (!repository?.repositoryId || !repository?.lockPath) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REPOSITORY_INVALID",
        "Structured repository entry is required for leasing",
      );
    }
    this.processContainmentAssertLive?.();
    const lockDirectory = path.dirname(repository.lockPath);
    ensureManagedDirectory(lockDirectory, {
      allowedRoot: this.dataRoot,
      label: "repository lock directory",
    });
    const lockPath = canonicalizeManagedPath(repository.lockPath, {
      allowedRoot: this.dataRoot,
      label: "repository OS lock",
      allowMissing: true,
      expectedType: "file",
    });
    const leaseId = randomUUID();
    const now = Date.now();
    const ownerProcessStartIdentity = this.processIdentityProbe(process.pid);
    const claimed = this.persistence.claimGitControllerRepositoryLease({
      repositoryId: repository.repositoryId,
      leaseId,
      operationId: String(operationId || "").trim(),
      kind: String(kind || "").trim(),
      ownerInstance: this.ownerInstance,
      ownerHostname: os.hostname(),
      ownerPid: process.pid,
      ownerProcessStartIdentity,
      now,
      ttlMs: this.ttlMs,
    });
    if (!claimed?.ok) {
      throw new GitControllerError(
        "GIT_CONTROLLER_REPOSITORY_BUSY",
        "Repository already has an active controller operation",
        {
          repositoryId: repository.repositoryId,
          conflict: claimed?.conflict || null,
        },
      );
    }
    const lockPayload = {
      schemaVersion: 2,
      lockRevision: 1,
      gitChildren: {},
      processContainment: this.processContainment,
      repositoryId: repository.repositoryId,
      leaseId,
      operationId: String(operationId || "").trim(),
      kind: String(kind || "").trim(),
      ownerInstance: this.ownerInstance,
      ownerPid: process.pid,
      ownerProcessStartIdentity,
      hostname: os.hostname(),
      fencingToken: claimed.lease.fencingToken,
      acquiredAt: claimed.lease.acquiredAt,
      heartbeatAt: claimed.lease.heartbeatAt,
      expiresAt: claimed.lease.expiresAt,
    };
    let recoveredLock = null;
    try {
      try {
        writeLockFile(lockPath, lockPayload, "wx");
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        recoveredLock = this.recoverStaleLock(repository, lockPath, claimed, now);
        writeLockFile(lockPath, lockPayload, "wx");
      }
    } catch (error) {
      this.persistence.releaseGitControllerRepositoryLease({
        repositoryId: repository.repositoryId,
        leaseId,
        ownerInstance: this.ownerInstance,
        fencingToken: claimed.lease.fencingToken,
      });
      if (error instanceof GitControllerError) throw error;
      throw new GitControllerError(
        "GIT_CONTROLLER_OS_LOCK_FAILED",
        "Unable to acquire repository OS lock",
        { repositoryId: repository.repositoryId, cause: error.code || error.message },
        { cause: error },
      );
    }
    return new RepositoryLease({
      manager: this,
      repository,
      operationId,
      kind,
      lease: claimed.lease,
      lockPath,
      lockPayload,
      recoveredLock,
    });
  }
}

export function createRepositoryLeaseManager(options = {}) {
  return new RepositoryLeaseManager(options);
}
