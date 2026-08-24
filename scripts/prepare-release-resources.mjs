#!/usr/bin/env node
import path from "path";
import { fileURLToPath } from "url";
import {
  findReleaseResourceViolations,
  prepareReleaseResources,
} from "../gateway/services/release-resources.js";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const args = process.argv.slice(2);
const verifyOnly = args[0] === "--verify";
const destinationArg = verifyOnly ? args[1] : args[0];

if (!destinationArg) {
  throw new Error("Usage: prepare-release-resources.mjs [--verify] <destination-root>");
}

const destination = path.resolve(process.cwd(), destinationArg);
if (!verifyOnly) {
  const prefix = `${repoRoot}${path.sep}`.toLowerCase();
  if (!`${destination}${path.sep}`.toLowerCase().startsWith(prefix)) {
    throw new Error(`Destination must be inside the repository: ${destination}`);
  }
  const result = prepareReleaseResources(repoRoot, destination);
  console.log(`Prepared sanitized release resources: ${destination} (skipped ${result.skipped.length})`);
}

const violations = findReleaseResourceViolations(destination);
if (violations.length) {
  throw new Error(`Release resource verification failed: ${violations.join("; ")}`);
}
console.log(`Verified sanitized release resources: ${destination}`);
