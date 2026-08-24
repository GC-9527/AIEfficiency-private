import { randomUUID } from "node:crypto";

export const DEVICE_RUNTIME_SCHEMA_VERSION = 1;

export const DEVICE_RUNTIME_STATUS = Object.freeze({
  IDLE: "idle",
  QUEUED: "queued",
  ACQUIRED: "acquired",
  RENEWED: "renewed",
  RELEASED: "released",
  CANCELLED: "cancelled",
  EXPIRED: "expired",
  RECOVERED: "recovered",
  UNCHANGED: "unchanged",
});

export const DEVICE_RUNTIME_ERROR = Object.freeze({
  INVALID_ARGUMENT: "DEVICE_RUNTIME_INVALID_ARGUMENT",
  REQUEST_CONFLICT: "DEVICE_RUNTIME_REQUEST_CONFLICT",
  REQUEST_NOT_FOUND: "DEVICE_RUNTIME_REQUEST_NOT_FOUND",
  LEASE_NOT_FOUND: "DEVICE_RUNTIME_LEASE_NOT_FOUND",
  LEASE_MISMATCH: "DEVICE_RUNTIME_LEASE_MISMATCH",
  LEASE_EXPIRED: "DEVICE_RUNTIME_LEASE_EXPIRED",
  ACTIVE_CANCEL_REQUIRES_LEASE: "DEVICE_RUNTIME_ACTIVE_CANCEL_REQUIRES_LEASE",
  STORAGE_CONTRACT: "DEVICE_RUNTIME_STORAGE_CONTRACT",
  STORAGE_FAILURE: "DEVICE_RUNTIME_STORAGE_FAILURE",
});

const DEFAULT_TTL_MS = 15_000;
const DEFAULT_HISTORY_LIMIT = 100;
export const MAX_DEVICE_RUNTIME_TTL_MS = 5 * 60 * 1000;

export class DeviceRuntimeError extends Error {
  constructor(code, message, { statusCode = 500, details = null, cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "DeviceRuntimeError";
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      statusCode: this.statusCode,
      message: this.message,
      details: this.details,
    };
  }
}

function runtimeError(code, message, statusCode, details = null) {
  return new DeviceRuntimeError(code, message, { statusCode, details });
}

function requiredText(value, field) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw runtimeError(
      DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
      `${field} is required`,
      400,
      { field },
    );
  }
  return normalized;
}

function optionalText(value) {
  return String(value ?? "").trim();
}

function positiveInteger(value, field, fallback) {
  if (value === undefined || value === null || value === "") {
    if (fallback !== undefined) return fallback;
    throw runtimeError(
      DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
      `${field} must be a positive integer`,
      400,
      { field, value },
    );
  }
  const normalized = Number(value);
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw runtimeError(
      DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
      `${field} must be a positive integer`,
      400,
      { field, value },
    );
  }
  return normalized;
}

function leaseTtl(value, field, fallback) {
  const normalized = positiveInteger(value, field, fallback);
  if (normalized > MAX_DEVICE_RUNTIME_TTL_MS) {
    throw runtimeError(
      DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
      `${field} must not exceed ${MAX_DEVICE_RUNTIME_TTL_MS}ms`,
      400,
      { field, value, max: MAX_DEVICE_RUNTIME_TTL_MS },
    );
  }
  return normalized;
}

function nonNegativeInteger(value, fallback = 0) {
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= 0 ? normalized : fallback;
}

function cloneJson(value, field = "metadata") {
  if (value === undefined) return null;
  try {
    return structuredClone(value);
  } catch {
    throw runtimeError(
      DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
      `${field} must be structured-cloneable`,
      400,
      { field },
    );
  }
}

function cloneRecord(value) {
  return value ? structuredClone(value) : value;
}

function initialState(serial) {
  return {
    schemaVersion: DEVICE_RUNTIME_SCHEMA_VERSION,
    serial,
    revision: 0,
    fencingCounter: 0,
    nextSequence: 1,
    lease: null,
    queue: [],
    history: [],
    updatedAt: 0,
  };
}

function normalizeState(raw, serial, historyLimit) {
  if (!raw) return initialState(serial);
  if (raw.serial && String(raw.serial) !== serial) {
    throw runtimeError(
      DEVICE_RUNTIME_ERROR.STORAGE_CONTRACT,
      "stored device runtime serial does not match the requested serial",
      500,
      { requestedSerial: serial, storedSerial: raw.serial },
    );
  }
  if (
    raw.schemaVersion !== undefined
    && Number(raw.schemaVersion) !== DEVICE_RUNTIME_SCHEMA_VERSION
  ) {
    throw runtimeError(
      DEVICE_RUNTIME_ERROR.STORAGE_CONTRACT,
      "unsupported device runtime schema version",
      500,
      { schemaVersion: raw.schemaVersion },
    );
  }

  const queue = Array.isArray(raw.queue)
    ? raw.queue
      .filter((entry) => entry && entry.requestId)
      .map((entry) => cloneRecord(entry))
      .sort((left, right) => nonNegativeInteger(left.sequence) - nonNegativeInteger(right.sequence))
    : [];
  const history = Array.isArray(raw.history)
    ? raw.history
      .filter((entry) => entry && entry.requestId)
      .slice(0, historyLimit)
      .map((entry) => cloneRecord(entry))
    : [];
  const largestSequence = queue.reduce(
    (largest, entry) => Math.max(largest, nonNegativeInteger(entry.sequence)),
    0,
  );
  const observedFencingToken = [raw.lease, ...history].reduce(
    (largest, entry) => Math.max(largest, nonNegativeInteger(entry?.fencingToken)),
    0,
  );

  return {
    schemaVersion: DEVICE_RUNTIME_SCHEMA_VERSION,
    serial,
    revision: nonNegativeInteger(raw.revision),
    fencingCounter: Math.max(nonNegativeInteger(raw.fencingCounter), observedFencingToken),
    nextSequence: Math.max(nonNegativeInteger(raw.nextSequence, 1), largestSequence + 1, 1),
    lease: raw.lease ? cloneRecord(raw.lease) : null,
    queue,
    history,
    updatedAt: nonNegativeInteger(raw.updatedAt),
  };
}

function requestIdentity(value) {
  return {
    storyId: optionalText(value?.storyId),
    taskId: optionalText(value?.taskId),
    operationKind: optionalText(value?.operationKind),
    ownerId: optionalText(value?.ownerId),
  };
}

function sameRequestIdentity(left, right) {
  const a = requestIdentity(left);
  const b = requestIdentity(right);
  return (
    a.storyId === b.storyId
    && a.taskId === b.taskId
    && a.operationKind === b.operationKind
    && a.ownerId === b.ownerId
  );
}

function findRequest(state, requestId) {
  if (state.lease?.requestId === requestId) {
    return { kind: "lease", value: state.lease, index: -1 };
  }
  const queueIndex = state.queue.findIndex((entry) => entry.requestId === requestId);
  if (queueIndex >= 0) {
    return { kind: "queue", value: state.queue[queueIndex], index: queueIndex };
  }
  const historyIndex = state.history.findIndex((entry) => entry.requestId === requestId);
  if (historyIndex >= 0) {
    return { kind: "history", value: state.history[historyIndex], index: historyIndex };
  }
  return null;
}

function findLeaseHistory(state, leaseId, fencingToken) {
  return state.history.find((entry) => (
    entry.leaseId === leaseId
    && Number(entry.fencingToken) === Number(fencingToken)
  )) || null;
}

function terminalRecord(value, status, now, reason = "") {
  return {
    requestId: value.requestId,
    storyId: value.storyId,
    taskId: value.taskId || "",
    operationKind: value.operationKind,
    ownerId: value.ownerId || "",
    leaseTtlMs: value.leaseTtlMs,
    metadata: cloneRecord(value.metadata),
    sequence: value.sequence,
    enqueuedAt: value.enqueuedAt,
    leaseId: value.leaseId || null,
    fencingToken: value.fencingToken || null,
    acquiredAt: value.acquiredAt || null,
    heartbeatAt: value.heartbeatAt || null,
    expiresAt: value.expiresAt || null,
    status,
    reason: optionalText(reason),
    terminalAt: now,
  };
}

function pushHistory(state, record, historyLimit) {
  state.history = [record, ...state.history.filter((entry) => entry.requestId !== record.requestId)]
    .slice(0, historyLimit);
}

function snapshotOf(state, now) {
  const leaseExpired = Boolean(state.lease && Number(state.lease.expiresAt) <= now);
  let status = DEVICE_RUNTIME_STATUS.IDLE;
  if (state.lease) status = leaseExpired
    ? DEVICE_RUNTIME_STATUS.EXPIRED
    : DEVICE_RUNTIME_STATUS.ACQUIRED;
  else if (state.queue.length) status = DEVICE_RUNTIME_STATUS.QUEUED;

  return {
    schemaVersion: DEVICE_RUNTIME_SCHEMA_VERSION,
    serial: state.serial,
    revision: state.revision,
    fencingCounter: state.fencingCounter,
    status,
    lease: state.lease
      ? { ...cloneRecord(state.lease), expired: leaseExpired }
      : null,
    queue: state.queue.map((entry, index) => ({
      ...cloneRecord(entry),
      position: index + 1,
    })),
    recentTerminal: state.history.map((entry) => cloneRecord(entry)),
    updatedAt: state.updatedAt,
    observedAt: now,
  };
}

function errorDescriptor(error) {
  return {
    code: error.code,
    statusCode: error.statusCode,
    message: error.message,
    details: error.details,
  };
}

function transitionResult(response, changed = false) {
  return { response, changed };
}

/**
 * Storage adapter contract:
 *
 * - read(serial) -> persisted state or null
 * - atomicUpdate(serial, transition) -> the `{ state, result }` envelope returned
 *   by transition. The adapter must load, invoke transition, persist `state`, and
 *   return the envelope in one serializable transaction for that serial.
 *
 * The coordinator deliberately knows nothing about SQLite or story bindings.
 */
export class DeviceRuntimeCoordinator {
  constructor({
    atomicUpdate,
    read,
    now = () => Date.now(),
    idFactory = () => randomUUID(),
    defaultTtlMs = DEFAULT_TTL_MS,
    historyLimit = DEFAULT_HISTORY_LIMIT,
  } = {}) {
    if (typeof atomicUpdate !== "function" || typeof read !== "function") {
      throw runtimeError(
        DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
        "atomicUpdate and read callbacks are required",
        400,
      );
    }
    if (typeof now !== "function" || typeof idFactory !== "function") {
      throw runtimeError(
        DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
        "now and idFactory must be functions",
        400,
      );
    }
    this.atomicUpdate = atomicUpdate;
    this.read = read;
    this.now = now;
    this.idFactory = idFactory;
    this.defaultTtlMs = leaseTtl(defaultTtlMs, "defaultTtlMs", DEFAULT_TTL_MS);
    this.historyLimit = positiveInteger(historyLimit, "historyLimit", DEFAULT_HISTORY_LIMIT);
  }

  async acquire(input = {}) {
    const serial = requiredText(input.serial, "serial");
    const request = {
      requestId: requiredText(input.requestId, "requestId"),
      storyId: requiredText(input.storyId, "storyId"),
      taskId: optionalText(input.taskId),
      operationKind: requiredText(input.operationKind, "operationKind"),
      ownerId: optionalText(input.ownerId),
      leaseTtlMs: leaseTtl(input.ttlMs, "ttlMs", this.defaultTtlMs),
      metadata: cloneJson(input.metadata),
    };

    return this.#mutate(serial, (state, now) => {
      let changed = false;
      const expiredLease = this.#reapExpired(state, now);
      if (expiredLease) changed = true;
      const recoveredLease = this.#grantNext(state, now);
      if (recoveredLease) changed = true;

      const existing = findRequest(state, request.requestId);
      if (existing) {
        if (!sameRequestIdentity(existing.value, request)) {
          return transitionResult({
            error: errorDescriptor(runtimeError(
              DEVICE_RUNTIME_ERROR.REQUEST_CONFLICT,
              "requestId already belongs to a different device-use request",
              409,
              { requestId: request.requestId },
            )),
          }, changed);
        }
        return transitionResult(
          this.#existingRequestResponse(state, existing, now, true),
          changed,
        );
      }

      const evicted = this.#evictByStoryId(state, request.storyId, request.requestId, now);
      if (evicted) changed = true;

      const queued = {
        ...request,
        sequence: state.nextSequence,
        enqueuedAt: now,
      };
      state.nextSequence += 1;
      state.queue.push(queued);
      changed = true;
      const grantedLease = this.#grantNext(state, now);
      const created = findRequest(state, request.requestId);
      return transitionResult({
        ...this.#existingRequestResponse(state, created, now, false),
        recoveredLease: recoveredLease ? cloneRecord(recoveredLease) : null,
        grantedLease: grantedLease?.requestId === request.requestId
          ? cloneRecord(grantedLease)
          : null,
        evicted: evicted,
      }, changed);
    });
  }

  async heartbeat(input = {}) {
    const serial = requiredText(input.serial, "serial");
    const leaseId = requiredText(input.leaseId, "leaseId");
    const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
    const ttlMs = leaseTtl(input.ttlMs, "ttlMs", this.defaultTtlMs);

    return this.#mutate(serial, (state, now) => {
      let changed = false;
      const expiredLease = this.#reapExpired(state, now);
      if (expiredLease) changed = true;
      const recoveredLease = this.#grantNext(state, now);
      if (recoveredLease) changed = true;

      if (
        state.lease?.leaseId === leaseId
        && Number(state.lease.fencingToken) === fencingToken
      ) {
        state.lease.heartbeatAt = now;
        state.lease.expiresAt = now + ttlMs;
        state.lease.leaseTtlMs = ttlMs;
        return transitionResult({
          ok: true,
          status: DEVICE_RUNTIME_STATUS.RENEWED,
          lease: cloneRecord(state.lease),
          snapshot: snapshotOf(state, now),
        }, true);
      }

      const terminal = findLeaseHistory(state, leaseId, fencingToken);
      if (terminal?.status === DEVICE_RUNTIME_STATUS.EXPIRED) {
        return transitionResult({
          error: errorDescriptor(runtimeError(
            DEVICE_RUNTIME_ERROR.LEASE_EXPIRED,
            "device lease has expired",
            410,
            { serial, leaseId, fencingToken },
          )),
        }, changed);
      }
      if (terminal) {
        return transitionResult({
          error: errorDescriptor(runtimeError(
            DEVICE_RUNTIME_ERROR.LEASE_NOT_FOUND,
            "device lease is no longer active",
            404,
            { serial, leaseId, fencingToken, terminalStatus: terminal.status },
          )),
        }, changed);
      }
      if (state.lease) {
        return transitionResult({
          error: errorDescriptor(runtimeError(
            DEVICE_RUNTIME_ERROR.LEASE_MISMATCH,
            "leaseId or fencingToken does not match the active device lease",
            409,
            { serial, leaseId, fencingToken },
          )),
        }, changed);
      }
      return transitionResult({
        error: errorDescriptor(runtimeError(
          DEVICE_RUNTIME_ERROR.LEASE_NOT_FOUND,
          "device lease was not found",
          404,
          { serial, leaseId, fencingToken },
        )),
      }, changed);
    });
  }

  async release(input = {}) {
    const serial = requiredText(input.serial, "serial");
    const leaseId = requiredText(input.leaseId, "leaseId");
    const fencingToken = positiveInteger(input.fencingToken, "fencingToken");
    const reason = optionalText(input.reason);

    return this.#mutate(serial, (state, now) => {
      let changed = false;
      const expiredLease = this.#reapExpired(state, now);
      if (expiredLease) changed = true;

      if (
        state.lease?.leaseId === leaseId
        && Number(state.lease.fencingToken) === fencingToken
      ) {
        const releasedLease = cloneRecord(state.lease);
        state.lease = null;
        pushHistory(
          state,
          terminalRecord(releasedLease, DEVICE_RUNTIME_STATUS.RELEASED, now, reason),
          this.historyLimit,
        );
        const nextLease = this.#grantNext(state, now);
        return transitionResult({
          ok: true,
          status: DEVICE_RUNTIME_STATUS.RELEASED,
          idempotent: false,
          requestId: releasedLease.requestId,
          releasedLease,
          nextLease: nextLease ? cloneRecord(nextLease) : null,
          snapshot: snapshotOf(state, now),
        }, true);
      }

      const terminal = findLeaseHistory(state, leaseId, fencingToken);
      const recoveredLease = this.#grantNext(state, now);
      if (recoveredLease) changed = true;
      if (terminal?.status === DEVICE_RUNTIME_STATUS.RELEASED) {
        return transitionResult({
          ok: true,
          status: DEVICE_RUNTIME_STATUS.RELEASED,
          idempotent: true,
          requestId: terminal.requestId,
          releasedLease: cloneRecord(terminal),
          nextLease: recoveredLease ? cloneRecord(recoveredLease) : null,
          snapshot: snapshotOf(state, now),
        }, changed);
      }
      if (terminal?.status === DEVICE_RUNTIME_STATUS.EXPIRED) {
        return transitionResult({
          error: errorDescriptor(runtimeError(
            DEVICE_RUNTIME_ERROR.LEASE_EXPIRED,
            "device lease expired before it could be released",
            410,
            { serial, leaseId, fencingToken },
          )),
        }, changed);
      }
      if (terminal) {
        return transitionResult({
          error: errorDescriptor(runtimeError(
            DEVICE_RUNTIME_ERROR.LEASE_NOT_FOUND,
            "device lease is no longer active",
            404,
            { serial, leaseId, fencingToken, terminalStatus: terminal.status },
          )),
        }, changed);
      }
      if (state.lease) {
        return transitionResult({
          error: errorDescriptor(runtimeError(
            DEVICE_RUNTIME_ERROR.LEASE_MISMATCH,
            "leaseId or fencingToken does not match the active device lease",
            409,
            { serial, leaseId, fencingToken },
          )),
        }, changed);
      }
      return transitionResult({
        error: errorDescriptor(runtimeError(
          DEVICE_RUNTIME_ERROR.LEASE_NOT_FOUND,
          "device lease was not found",
          404,
          { serial, leaseId, fencingToken },
        )),
      }, changed);
    });
  }

  async cancel(input = {}) {
    const serial = requiredText(input.serial, "serial");
    const requestId = requiredText(input.requestId, "requestId");
    const leaseId = optionalText(input.leaseId);
    const fencingToken = input.fencingToken === undefined || input.fencingToken === null
      ? null
      : positiveInteger(input.fencingToken, "fencingToken");
    const reason = optionalText(input.reason);

    return this.#mutate(serial, (state, now) => {
      let changed = false;
      const expiredLease = this.#reapExpired(state, now);
      if (expiredLease) changed = true;

      const queueIndex = state.queue.findIndex((entry) => entry.requestId === requestId);
      if (queueIndex >= 0) {
        const [cancelled] = state.queue.splice(queueIndex, 1);
        pushHistory(
          state,
          terminalRecord(cancelled, DEVICE_RUNTIME_STATUS.CANCELLED, now, reason),
          this.historyLimit,
        );
        const nextLease = this.#grantNext(state, now);
        return transitionResult({
          ok: true,
          status: DEVICE_RUNTIME_STATUS.CANCELLED,
          idempotent: false,
          requestId,
          cancelled: cloneRecord(cancelled),
          nextLease: nextLease ? cloneRecord(nextLease) : null,
          snapshot: snapshotOf(state, now),
        }, true);
      }

      if (state.lease?.requestId === requestId) {
        if (!leaseId || fencingToken === null) {
          return transitionResult({
            error: errorDescriptor(runtimeError(
              DEVICE_RUNTIME_ERROR.ACTIVE_CANCEL_REQUIRES_LEASE,
              "cancelling an active device request requires leaseId and fencingToken",
              409,
              { serial, requestId },
            )),
          }, changed);
        }
        if (
          state.lease.leaseId !== leaseId
          || Number(state.lease.fencingToken) !== fencingToken
        ) {
          return transitionResult({
            error: errorDescriptor(runtimeError(
              DEVICE_RUNTIME_ERROR.LEASE_MISMATCH,
              "leaseId or fencingToken does not match the active device lease",
              409,
              { serial, requestId, leaseId, fencingToken },
            )),
          }, changed);
        }
        const cancelled = cloneRecord(state.lease);
        state.lease = null;
        pushHistory(
          state,
          terminalRecord(cancelled, DEVICE_RUNTIME_STATUS.CANCELLED, now, reason),
          this.historyLimit,
        );
        const nextLease = this.#grantNext(state, now);
        return transitionResult({
          ok: true,
          status: DEVICE_RUNTIME_STATUS.CANCELLED,
          idempotent: false,
          requestId,
          cancelled,
          nextLease: nextLease ? cloneRecord(nextLease) : null,
          snapshot: snapshotOf(state, now),
        }, true);
      }

      const terminal = state.history.find((entry) => entry.requestId === requestId);
      const recoveredLease = this.#grantNext(state, now);
      if (recoveredLease) changed = true;
      if (terminal) {
        return transitionResult({
          ok: true,
          status: terminal.status,
          idempotent: true,
          requestId,
          terminal: cloneRecord(terminal),
          nextLease: recoveredLease ? cloneRecord(recoveredLease) : null,
          snapshot: snapshotOf(state, now),
        }, changed);
      }
      return transitionResult({
        error: errorDescriptor(runtimeError(
          DEVICE_RUNTIME_ERROR.REQUEST_NOT_FOUND,
          "device-use request was not found",
          404,
          { serial, requestId },
        )),
      }, changed);
    });
  }

  async recoverExpired(input = {}) {
    const serial = requiredText(
      typeof input === "string" ? input : input.serial,
      "serial",
    );
    return this.#mutate(serial, (state, now) => {
      const expiredLease = this.#reapExpired(state, now);
      const nextLease = this.#grantNext(state, now);
      const changed = Boolean(expiredLease || nextLease);
      return transitionResult({
        ok: true,
        status: changed ? DEVICE_RUNTIME_STATUS.RECOVERED : DEVICE_RUNTIME_STATUS.UNCHANGED,
        expiredLease: expiredLease ? cloneRecord(expiredLease) : null,
        nextLease: nextLease ? cloneRecord(nextLease) : null,
        snapshot: snapshotOf(state, now),
      }, changed);
    });
  }

  async snapshot(input = {}, options = {}) {
    const serial = requiredText(
      typeof input === "string" ? input : input.serial,
      "serial",
    );
    const recoverExpired = typeof input === "string"
      ? options.recoverExpired !== false
      : input.recoverExpired !== false;
    let raw;
    try {
      raw = await this.read(serial);
    } catch (cause) {
      throw new DeviceRuntimeError(
        DEVICE_RUNTIME_ERROR.STORAGE_FAILURE,
        "failed to read device runtime state",
        { statusCode: 500, details: { serial }, cause },
      );
    }
    const now = this.#timestamp();
    const state = normalizeState(raw, serial, this.historyLimit);
    if (
      recoverExpired
      && (
        (state.lease && Number(state.lease.expiresAt) <= now)
        || (!state.lease && state.queue.length > 0)
      )
    ) {
      const recovered = await this.recoverExpired({ serial });
      return recovered.snapshot;
    }
    return snapshotOf(state, now);
  }

  async #mutate(serial, handler) {
    const now = this.#timestamp();
    let envelope;
    try {
      envelope = await this.atomicUpdate(serial, (current) => {
        const state = normalizeState(current, serial, this.historyLimit);
        const transition = handler(state, now);
        if (transition.changed) {
          state.revision += 1;
          state.updatedAt = now;
        }
        if (transition.response?.snapshot) {
          transition.response.snapshot = snapshotOf(state, now);
        }
        return { state, result: transition.response };
      });
    } catch (cause) {
      if (cause instanceof DeviceRuntimeError) throw cause;
      throw new DeviceRuntimeError(
        DEVICE_RUNTIME_ERROR.STORAGE_FAILURE,
        "device runtime atomic update failed",
        { statusCode: 500, details: { serial }, cause },
      );
    }
    if (
      !envelope
      || typeof envelope !== "object"
      || !("state" in envelope)
      || !("result" in envelope)
    ) {
      throw runtimeError(
        DEVICE_RUNTIME_ERROR.STORAGE_CONTRACT,
        "atomicUpdate must return the transition envelope",
        500,
        { serial },
      );
    }
    if (envelope.result?.error) {
      const error = envelope.result.error;
      throw new DeviceRuntimeError(error.code, error.message, {
        statusCode: error.statusCode,
        details: error.details,
      });
    }
    return envelope.result;
  }

  #timestamp() {
    const value = Number(this.now());
    if (!Number.isSafeInteger(value) || value < 0) {
      throw runtimeError(
        DEVICE_RUNTIME_ERROR.INVALID_ARGUMENT,
        "now() must return a non-negative safe integer timestamp",
        500,
      );
    }
    return value;
  }

  #reapExpired(state, now) {
    if (!state.lease || Number(state.lease.expiresAt) > now) return null;
    const expiredLease = cloneRecord(state.lease);
    state.lease = null;
    pushHistory(
      state,
      terminalRecord(expiredLease, DEVICE_RUNTIME_STATUS.EXPIRED, now, "ttl_expired"),
      this.historyLimit,
    );
    return expiredLease;
  }

  #grantNext(state, now) {
    if (state.lease || !state.queue.length) return null;
    const request = state.queue.shift();
    state.fencingCounter += 1;
    const generatedLeaseId = optionalText(this.idFactory({
      type: "device-lease",
      serial: state.serial,
      requestId: request.requestId,
      fencingToken: state.fencingCounter,
    }));
    if (!generatedLeaseId) {
      throw runtimeError(
        DEVICE_RUNTIME_ERROR.STORAGE_CONTRACT,
        "idFactory must return a non-empty lease id",
        500,
        { serial: state.serial, requestId: request.requestId },
      );
    }
    const duplicateLeaseId = state.lease?.leaseId === generatedLeaseId
      || state.history.some((entry) => entry.leaseId === generatedLeaseId);
    if (duplicateLeaseId) {
      throw runtimeError(
        DEVICE_RUNTIME_ERROR.STORAGE_CONTRACT,
        "idFactory returned a duplicate lease id",
        500,
        { serial: state.serial, leaseId: generatedLeaseId },
      );
    }
    state.lease = {
      ...request,
      leaseId: generatedLeaseId,
      fencingToken: state.fencingCounter,
      acquiredAt: now,
      heartbeatAt: now,
      expiresAt: now + request.leaseTtlMs,
    };
    return state.lease;
  }

  #evictByStoryId(state, storyId, excludeRequestId, now) {
    const target = optionalText(storyId);
    if (!target) return null;
    const evictedLeases = [];
    const evictedQueued = [];

    if (
      state.lease
      && optionalText(state.lease.storyId) === target
      && state.lease.requestId !== excludeRequestId
    ) {
      const releasedLease = cloneRecord(state.lease);
      state.lease = null;
      pushHistory(
        state,
        terminalRecord(releasedLease, DEVICE_RUNTIME_STATUS.RELEASED, now, "evicted_same_story"),
        this.historyLimit,
      );
      evictedLeases.push(cloneRecord(releasedLease));
    }

    const remainingQueue = [];
    for (const entry of state.queue) {
      if (
        optionalText(entry.storyId) === target
        && entry.requestId !== excludeRequestId
      ) {
        pushHistory(
          state,
          terminalRecord(entry, DEVICE_RUNTIME_STATUS.CANCELLED, now, "evicted_same_story"),
          this.historyLimit,
        );
        evictedQueued.push(cloneRecord(entry));
      } else {
        remainingQueue.push(entry);
      }
    }
    if (evictedQueued.length) state.queue = remainingQueue;

    if (!evictedLeases.length && !evictedQueued.length) return null;
    return { evictedLeases, evictedQueued };
  }

  #existingRequestResponse(state, existing, now, idempotent) {
    if (existing.kind === "lease") {
      return {
        ok: true,
        status: DEVICE_RUNTIME_STATUS.ACQUIRED,
        idempotent,
        requestId: existing.value.requestId,
        position: 0,
        lease: cloneRecord(existing.value),
        snapshot: snapshotOf(state, now),
      };
    }
    if (existing.kind === "queue") {
      return {
        ok: true,
        status: DEVICE_RUNTIME_STATUS.QUEUED,
        idempotent,
        requestId: existing.value.requestId,
        position: existing.index + 1,
        lease: null,
        snapshot: snapshotOf(state, now),
      };
    }
    return {
      ok: true,
      status: existing.value.status,
      idempotent,
      requestId: existing.value.requestId,
      position: null,
      lease: null,
      terminal: cloneRecord(existing.value),
      snapshot: snapshotOf(state, now),
    };
  }
}

export function createDeviceRuntimeCoordinator(options) {
  return new DeviceRuntimeCoordinator(options);
}
