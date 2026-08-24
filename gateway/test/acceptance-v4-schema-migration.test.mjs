import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";

import { applyAiautoworkSchema } from "../db/aiautowork-schema.js";

test("v4.1 preview tables migrate in place before track-group indexes are created", () => {
  const db = new Database(":memory:");
  try {
    db.exec(`
      CREATE TABLE acceptance_runs (
        id TEXT PRIMARY KEY,
        context_id TEXT NOT NULL,
        protocol TEXT NOT NULL,
        mode_or_tier TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'CREATED',
        candidate_identity_hash TEXT,
        candidate_json TEXT NOT NULL DEFAULT '{}',
        source_snapshot_hash TEXT,
        environment_id TEXT,
        gates_json TEXT NOT NULL DEFAULT '[]',
        claims_json TEXT NOT NULL DEFAULT '[]',
        impact_matrix_json TEXT NOT NULL DEFAULT '{}',
        findings_json TEXT NOT NULL DEFAULT '[]',
        unknowns_json TEXT NOT NULL DEFAULT '[]',
        residual_risks_json TEXT NOT NULL DEFAULT '[]',
        repair_rounds INTEGER NOT NULL DEFAULT 0,
        project_change_decision TEXT NOT NULL DEFAULT 'NOT_ASSESSED',
        production_readiness TEXT NOT NULL DEFAULT 'NOT_ASSESSED',
        story_point_decision TEXT NOT NULL DEFAULT 'NOT_APPLICABLE',
        source_sync_decision TEXT NOT NULL DEFAULT 'DENIED',
        source_sync_status TEXT NOT NULL DEFAULT 'NOT_ATTEMPTED',
        supersedes_run_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE acceptance_evidence (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        gate_id TEXT,
        kind TEXT NOT NULL,
        uri TEXT,
        sha256 TEXT,
        candidate_identity_hash TEXT,
        source_snapshot_hash TEXT,
        environment_id TEXT,
        command_text TEXT,
        exit_code INTEGER,
        observed_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
    `);

    applyAiautoworkSchema(db);

    const runColumns = new Set(db.prepare("PRAGMA table_info(acceptance_runs)").all().map((row) => row.name));
    assert.ok(runColumns.has("candidate_evidence_consistent"));
    assert.ok(runColumns.has("candidate_consistency_reasons_json"));
    assert.ok(runColumns.has("track_group_id"));
    const evidenceColumns = new Set(db.prepare("PRAGMA table_info(acceptance_evidence)").all().map((row) => row.name));
    assert.ok(evidenceColumns.has("trust_level"));
    assert.ok(evidenceColumns.has("producer"));
    const trackIndex = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='index' AND name='idx_acceptance_runs_track_group'
    `).get();
    assert.equal(trackIndex.name, "idx_acceptance_runs_track_group");
  } finally {
    db.close();
  }
});
