import test from "node:test";
import assert from "node:assert/strict";

import {
  chooseTaskUiView,
  normalizeTaskUi,
  taskUiSourceRows,
} from "./resourceTaskUiModel.mjs";

test("task UI views, labels and order come from the selected script", () => {
  const ui = normalizeTaskUi({
    ui: {
      schemaVersion: 1,
      defaultView: "startup-report",
      runSections: [{ id: "flow", kind: "workflow", label: "启动流程" }],
      views: [
        { id: "startup-raw", kind: "table", label: "启动原始点", source: "event:startup", columns: [{ key: "elapsed_ms", label: "启动耗时", unit: "ms" }] },
        { id: "startup-report", kind: "artifacts", label: "启动报告", artifactKeys: ["report_md"] },
      ],
    },
  });
  assert.equal(ui.legacy, false);
  assert.deepEqual(ui.views.map((view) => view.label), ["启动原始点", "启动报告"]);
  assert.equal(chooseTaskUiView(ui, "missing"), "startup-report");
});

test("legacy scripts keep the compatible AppMarket UI", () => {
  const ui = normalizeTaskUi({ id: "old-run" });
  assert.equal(ui.legacy, true);
  assert.deepEqual(ui.views.map((view) => view.id), ["dashboard", "raw", "report"]);
});

test("generic channel rows are isolated and flattened for safe rendering", () => {
  const rows = taskUiSourceRows(
    { source: "event:startup" },
    {
      run: {
        live: {
          channelEvents: [
            { channel: "other", sequence: 1, values: { elapsed_ms: 1 } },
            { channel: "startup", sequence: 2, elapsed_s: 0.5, values: { elapsed_ms: 836, ok: false } },
          ],
        },
      },
    },
  );
  assert.deepEqual(rows, [{ sequence: 2, target_elapsed_s: 0.5, at: "", message: "", elapsed_ms: 836, ok: false }]);
});

test("unsupported schemas downgrade without exposing arbitrary UI kinds", () => {
  const ui = normalizeTaskUi({ ui: { schemaVersion: 99, views: [{ id: "x", kind: "html", label: "危险" }] } });
  assert.equal(ui.legacy, true);
  assert.match(ui.warning, /安全降级/);
});
