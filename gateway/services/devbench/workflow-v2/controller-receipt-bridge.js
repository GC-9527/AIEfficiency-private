import { createHash } from "node:crypto";

import { canonicalSha256 } from "./envelope-store.js";
import {
  createWorkflowV2BuildController,
} from "./build-controller.js";
import {
  createStoryLeaseDeviceProxy,
  freezeStoryDeviceLeaseContext,
} from "../device-operation-guard-service.js";
import { WORKFLOW_V2_SCHEMA_IDS, workflowV2SchemaRegistry } from "./schema-registry.js";

export const WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID = "workflow-v2.build-controller";
export const WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID = "workflow-v2.story-device-proxy";
export const WORKFLOW_V2_CONTROLLER_RECEIPT_BRIDGE_KIND = "workflow-v2-controller-receipt-bridge-v1";

const BUILD_TYPES = new Set(["debug", "release"]);
const SAFE_ACTION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_TASK = /^(?::[A-Za-z0-9_.-]+)*:?[A-Za-z][A-Za-z0-9_]*$/;
const CREATED_BRIDGES = new WeakSet();

function text(value, max = 1000) {
  return Array.from(String(value ?? "").trim()).slice(0, max).join("");
}

function sha256Text(value) {
  return createHash("sha256").update(String(value || ""), "utf8").digest("hex");
}

function blocked(code, message, details = null) {
  const summary = text(message, 1800) || "controller execution was blocked";
  return {
    status: "BLOCKED",
    exitCode: null,
    summary,
    output: JSON.stringify({ status: "BLOCKED", code, summary, details }),
  };
}

function frozenRoot(dispatch, rootId) {
  const roots = dispatch?.context?.scope?.roots;
  const matches = (Array.isArray(roots) ? roots : []).filter((entry) => entry?.rootId === rootId);
  return matches.length === 1 ? matches[0] : null;
}

function validReceipt(receipt) {
  return workflowV2SchemaRegistry.validate(WORKFLOW_V2_SCHEMA_IDS.evidenceReceipt, receipt).valid;
}

function buildBinding(result, receipt) {
  const selector = receipt.selector || {};
  return {
    controller: {
      kind: "BUILD",
      receiptId: receipt.receiptId,
      operationId: receipt.operationId,
      resultCode: text(result?.code, 160) || null,
      storyId: text(selector.storyId, 160) || null,
      repositoryId: text(selector.repositoryId, 200) || null,
      rootId: text(selector.rootId, 32) || receipt.rootId || null,
      storyFlavor: text(selector.storyFlavor, 100) || null,
      flavor: text(selector.flavor, 100) || null,
      buildType: text(selector.buildType, 20) || null,
      task: text(selector.task, 160) || null,
      head: text(selector.head, 64) || null,
      version: selector.version && typeof selector.version === "object"
        ? {
          versionName: text(selector.version.versionName, 100) || null,
          versionCode: Number.isSafeInteger(selector.version.versionCode) ? selector.version.versionCode : null,
        }
        : null,
      artifact: selector.artifact && typeof selector.artifact === "object"
        ? {
          outputRef: text(selector.artifact.outputRef, 600) || null,
          sha256: text(selector.artifact.sha256, 64) || null,
          sizeBytes: Number.isSafeInteger(selector.artifact.sizeBytes) ? selector.artifact.sizeBytes : null,
        }
        : null,
    },
  };
}

function deviceBinding(result, receipt) {
  const selector = receipt.selector || {};
  return {
    controller: {
      kind: "DEVICE_ACTION",
      receiptId: receipt.receiptId,
      operationId: receipt.operationId,
      resultCode: text(result?.code, 160) || null,
      storyId: text(selector.storyId, 160) || null,
      businessAction: text(selector.businessAction, 128) || null,
      serialSha256: text(selector.serialSha256, 64) || null,
      leaseId: text(selector.leaseId, 300) || null,
      fencingToken: Number.isSafeInteger(selector.fencingToken) ? selector.fencingToken : null,
    },
  };
}

function bridgeOutput(status, code, binding) {
  return JSON.stringify({ status, code: text(code, 160) || null, ...binding });
}

/**
 * Creates the two reserved receipt adapters.  The default production bridge is
 * intentionally useful-but-closed: the Build Controller has no confined
 * executor broker and the Device Proxy has no attested business-action
 * adapters.  Deployments must inject those capabilities here; no profile argv,
 * free-form task/flavor, serial, lease, or model parameter reaches them.
 */
export function createWorkflowV2ControllerReceiptBridge({
  tab,
  dispatch,
  buildController = null,
  buildControllerOptions = {},
  deviceActions = Object.freeze({}),
  deviceProxyOptions = {},
} = {}) {
  const controller = buildController || createWorkflowV2BuildController(buildControllerOptions);

  const buildHandler = async ({ action, adapterId, executorId, rootId, adapterArgs }) => {
    if (action !== "BUILD" || adapterId !== WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID) {
      return blocked("WORKFLOW_V2_BUILD_BRIDGE_ACTION_MISMATCH", "BUILD bridge identity mismatch");
    }
    const root = frozenRoot(dispatch, rootId);
    const buildType = text(adapterArgs?.buildType, 20).toLowerCase();
    if (!root || !text(root.repositoryId, 200) || !/^[a-f0-9]{40,64}$/.test(text(root.headSha, 64))
      || !text(root.flavor, 100)) {
      return blocked(
        "WORKFLOW_V2_BUILD_FROZEN_ROOT_INCOMPLETE",
        "BUILD requires one frozen repositoryId/HEAD/Flavor root",
        { executorId, rootId },
      );
    }
    if (!BUILD_TYPES.has(buildType)) {
      return blocked(
        "WORKFLOW_V2_BUILD_TYPE_NOT_FROZEN",
        "BUILD buildType must be frozen to debug or release by the trusted executor registry",
        { executorId, rootId },
      );
    }
    const result = await controller.execute({
      storyId: String(tab?.id || ""),
      repositoryId: String(root.repositoryId),
      rootId,
      buildType,
    });
    const receipt = result?.receipt;
    if (!validReceipt(receipt) || receipt.action !== "BUILD" || receipt.status !== result?.status
      || receipt.rootId !== rootId) {
      return blocked("WORKFLOW_V2_BUILD_CONTROLLER_RECEIPT_INVALID", "Build Controller returned an invalid receipt");
    }
    const selector = receipt.selector;
    if (receipt.status === "PASS") {
      const artifact = selector?.artifact;
      const validSelector = selector?.storyId === String(tab?.id || "")
        && selector?.repositoryId === String(root.repositoryId)
        && selector?.rootId === rootId
        && selector?.buildType === buildType
        && selector?.storyFlavor === String(root.flavor)
        && selector?.head === String(root.headSha)
        && SAFE_TASK.test(String(selector?.task || ""))
        && artifact?.outputRef === receipt.outputRef
        && artifact?.sha256 === receipt.sha256
        && /^[a-f0-9]{64}$/.test(String(artifact?.sha256 || ""))
        && Number.isSafeInteger(artifact?.sizeBytes)
        && artifact.sizeBytes >= 0;
      if (!validSelector) {
        return blocked(
          "WORKFLOW_V2_BUILD_CONTROLLER_BINDING_MISMATCH",
          "Build Controller receipt does not match the frozen root/build selector",
        );
      }
    } else if (selector && (selector.repositoryId !== String(root.repositoryId)
      || selector.rootId !== rootId || selector.buildType !== buildType || selector.head !== String(root.headSha))) {
      return blocked(
        "WORKFLOW_V2_BUILD_CONTROLLER_BINDING_MISMATCH",
        "Blocked Build Controller receipt drifted from the frozen selector",
      );
    }
    const receiptBinding = buildBinding(result, receipt);
    return {
      status: receipt.status,
      exitCode: Number.isInteger(receipt.exitCode) ? receipt.exitCode : null,
      summary: text(receipt.summary, 2000) || `BUILD ${receipt.status}`,
      output: bridgeOutput(receipt.status, result?.code, receiptBinding),
      receiptBinding,
    };
  };

  const deviceHandler = async ({ action, adapterId, executorId, adapterArgs }) => {
    if (action !== "DEVICE_ACTION" || adapterId !== WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID) {
      return blocked("WORKFLOW_V2_DEVICE_BRIDGE_ACTION_MISMATCH", "Device Proxy bridge identity mismatch");
    }
    const businessAction = text(adapterArgs?.businessAction, 128);
    if (!SAFE_ACTION.test(businessAction)) {
      return blocked(
        "WORKFLOW_V2_DEVICE_BUSINESS_ACTION_NOT_FROZEN",
        "DEVICE_ACTION requires executorId to map to one frozen businessAction",
        { executorId },
      );
    }
    const snapshot = dispatch?.deviceLeaseSnapshot;
    const serial = text(tab?.deviceSerial, 300);
    const frozenSerialSha256 = canonicalSha256(serial);
    if (!snapshot || !serial || snapshot.serialSha256 !== sha256Text(serial)
      || !text(snapshot.leaseId, 300) || !Number.isSafeInteger(snapshot.fencingToken)
      || snapshot.fencingToken < 1) {
      return blocked(
        "WORKFLOW_V2_DEVICE_FROZEN_LEASE_INVALID",
        "DEVICE_ACTION requires the exact dispatch-sealed story lease",
        { executorId },
      );
    }
    let frozenContext;
    try {
      frozenContext = freezeStoryDeviceLeaseContext({
        story: tab,
        lease: {
          storyId: String(tab?.id || ""),
          serial,
          leaseId: snapshot.leaseId,
          fencingToken: snapshot.fencingToken,
        },
      });
    } catch (error) {
      return blocked(error?.code || "WORKFLOW_V2_DEVICE_FROZEN_LEASE_INVALID", error?.message || error);
    }
    const proxy = createStoryLeaseDeviceProxy({
      ...deviceProxyOptions,
      frozenContext,
      actions: deviceActions,
    });
    const result = await proxy.execute({ businessAction });
    const receipt = result?.receipt;
    if (!validReceipt(receipt) || receipt.action !== "DEVICE_ACTION" || receipt.status !== result?.status) {
      return blocked("WORKFLOW_V2_DEVICE_PROXY_RECEIPT_INVALID", "Device Proxy returned an invalid receipt");
    }
    const selector = receipt.selector;
    if (selector?.storyId !== String(tab?.id || "")
      || selector?.businessAction !== businessAction
      || selector?.serialSha256 !== frozenSerialSha256
      || selector?.leaseId !== snapshot.leaseId
      || selector?.fencingToken !== snapshot.fencingToken) {
      return blocked(
        "WORKFLOW_V2_DEVICE_PROXY_BINDING_MISMATCH",
        "Device Proxy receipt does not match the frozen story lease/action",
      );
    }
    const receiptBinding = deviceBinding(result, receipt);
    return {
      status: receipt.status,
      exitCode: null,
      summary: text(receipt.summary, 2000) || `DEVICE_ACTION ${receipt.status}`,
      output: bridgeOutput(receipt.status, result?.code, receiptBinding),
      receiptBinding,
    };
  };

  const bridge = Object.freeze({
    kind: WORKFLOW_V2_CONTROLLER_RECEIPT_BRIDGE_KIND,
    adapterHandlers: Object.freeze({
      [WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID]: buildHandler,
      [WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID]: deviceHandler,
    }),
  });
  CREATED_BRIDGES.add(bridge);
  return bridge;
}

export function isWorkflowV2ControllerReceiptBridge(value) {
  return !!value
    && CREATED_BRIDGES.has(value)
    && value.kind === WORKFLOW_V2_CONTROLLER_RECEIPT_BRIDGE_KIND
    && Object.isFrozen(value)
    && Object.isFrozen(value.adapterHandlers)
    && typeof value.adapterHandlers[WORKFLOW_V2_BUILD_CONTROLLER_ADAPTER_ID] === "function"
    && typeof value.adapterHandlers[WORKFLOW_V2_DEVICE_PROXY_ADAPTER_ID] === "function";
}
