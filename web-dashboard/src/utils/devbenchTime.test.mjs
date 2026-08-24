import assert from "node:assert/strict";
import test from "node:test";
import {
  formatChineseDateTime,
  formatClockTime,
  formatHistoryAwareTime,
  toTimeMs,
} from "./devbenchTime.js";

test("formatHistoryAwareTime shows full Chinese date time after more than one day", () => {
  const sentAt = new Date(2026, 6, 1, 12, 0, 0).getTime();
  const now = sentAt + 24 * 60 * 60 * 1000 + 1000;
  assert.equal(formatHistoryAwareTime(sentAt, now), "2026年7月1日 12:00:00");
});

test("formatHistoryAwareTime keeps clock-only text within one day", () => {
  const sentAt = new Date(2026, 6, 14, 9, 5, 6).getTime();
  const now = sentAt + 60 * 60 * 1000;
  assert.equal(formatHistoryAwareTime(sentAt, now), "09:05:06");
});

test("toTimeMs parses SQLite local datetime strings as local time", () => {
  const parsed = toTimeMs("2026-07-01 12:00:00");
  assert.equal(formatChineseDateTime(parsed), "2026年7月1日 12:00:00");
  assert.equal(formatClockTime(parsed), "12:00:00");
});
