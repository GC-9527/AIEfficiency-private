import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import path from "node:path";

import * as storyStore from "../store.js";

const CONTROLLED_ACTIONS = new Set(["BUILD", "TEST", "DEVICE_ACTION", "DB_QUERY", "CAPTURE"]);
const OUTPUT_REF_PATTERN = /^storydev:\/workflow-v2\/receipt-output\/([a-f0-9]{64})\.txt$/;
const CAPTURE_OUTPUT_REF_PATTERN = /^storydev:\/workflow-v2\/capture-output\/([a-f0-9]{64})\.bin$/;

function sameOrChildPath(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function invalid(reason) {
  return Object.freeze({ valid: false, reason });
}

/**
 * Re-read the Gateway-owned, content-addressed output artifact referenced by a
 * successful controlled receipt. The signed envelope alone is insufficient:
 * a deleted, replaced, or symlinked artifact must not authorize PASS.
 */
export function verifyControlledReceiptOutput({
  tab,
  receipt,
  storageApi = storyStore,
} = {}) {
  if (receipt?.status !== "PASS" || !CONTROLLED_ACTIONS.has(String(receipt?.action || ""))) {
    return Object.freeze({ valid: true, reason: null });
  }
  const outputRef = String(receipt.outputRef || "");
  const standardMatch = OUTPUT_REF_PATTERN.exec(outputRef);
  const captureMatch = receipt.action === "CAPTURE" ? CAPTURE_OUTPUT_REF_PATTERN.exec(outputRef) : null;
  const match = standardMatch || captureMatch;
  const receiptSha256 = String(receipt.sha256 || "");
  if (!match || !/^[a-f0-9]{64}$/.test(receiptSha256) || match[1] !== receiptSha256) {
    return invalid("controlled receipt outputRef/sha256 is missing or inconsistent");
  }

  let storyDirectory;
  try {
    storyDirectory = storageApi?.getStoryStoragePaths?.(tab, { create: false, persist: false })?.storyDirectory;
  } catch (error) {
    return invalid(`controlled receipt storage is unavailable: ${error?.message || error}`);
  }
  if (typeof storyDirectory !== "string" || !path.isAbsolute(storyDirectory)) {
    return invalid("controlled receipt storyDirectory is unavailable");
  }

  const expectedPath = path.join(
    storyDirectory,
    "workflow-v2",
    captureMatch ? "capture-output" : "receipt-output",
    captureMatch ? `${receiptSha256}.bin` : `${receiptSha256}.txt`,
  );
  if (!sameOrChildPath(path.resolve(storyDirectory), path.resolve(expectedPath))) {
    return invalid("controlled receipt output path escapes story storage");
  }
  try {
    storageApi?.validateStoryStorageTarget?.(tab, expectedPath, {
      baseDirectory: storyDirectory,
      mustExist: true,
      expectedType: "file",
    });
    const stat = lstatSync(expectedPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return invalid("controlled receipt output is not a regular file");
    const realStoryDirectory = realpathSync(storyDirectory);
    const realOutputPath = realpathSync(expectedPath);
    if (!sameOrChildPath(realStoryDirectory, realOutputPath)) {
      return invalid("controlled receipt output resolves outside story storage");
    }
    const actualSha256 = createHash("sha256").update(readFileSync(realOutputPath)).digest("hex");
    if (actualSha256 !== receiptSha256) return invalid("controlled receipt output sha256 mismatch");
  } catch (error) {
    return invalid(`controlled receipt output cannot be verified: ${error?.message || error}`);
  }
  return Object.freeze({ valid: true, reason: null });
}

export function isControlledReceiptAction(action) {
  return CONTROLLED_ACTIONS.has(String(action || ""));
}
