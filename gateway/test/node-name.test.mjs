import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanNodeNamePart, configuredNodeDisplayName, formatNodeDisplayName } from "../services/node-name.js";

test("formatNodeDisplayName prefixes owner and keeps an existing prefix", () => {
  assert.equal(formatNodeDisplayName("alice", "center-a"), "alice-center-a");
  assert.equal(formatNodeDisplayName("alice", "alice-center-a"), "alice-center-a");
  assert.equal(formatNodeDisplayName("", "center-a"), "center-a");
});

test("configuredNodeDisplayName uses fallback when suffix is empty", () => {
  assert.equal(configuredNodeDisplayName({ servers: { nodeOwnerName: "alice", nodeName: "" } }, "host-a"), "alice-host-a");
  assert.equal(cleanNodeNamePart("  alice   center  "), "alice center");
});
