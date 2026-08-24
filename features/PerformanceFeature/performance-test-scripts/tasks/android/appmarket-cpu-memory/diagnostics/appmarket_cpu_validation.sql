-- Named PerfettoSQL queries consumed by src/perfetto_cpu_validator.py.
-- The validator substitutes only validated package literals and numeric window
-- values. Keep each PERFETTO_QUERY section independently executable.

-- PERFETTO_QUERY: data_loss
SELECT
  name,
  idx,
  severity,
  source,
  value
FROM stats
WHERE severity = 'data_loss'
  AND value != 0
ORDER BY name, idx;

-- PERFETTO_QUERY: window_metrics
WITH
input_windows(
  sample_index,
  start_ns,
  end_ns,
  logical_cpus,
  sampler_device_pct
) AS (
  VALUES
    __WINDOW_VALUES__
),
trace_bounds AS (
  SELECT
    trace_start() AS trace_start_ns,
    trace_end() AS trace_end_ns
),
sched_bounds AS (
  SELECT
    MIN(ts) AS sched_start_ns,
    MAX(ts + dur) AS sched_end_ns
  FROM sched_slice
  WHERE dur > 0
),
target_sched AS (
  SELECT
    s.ts,
    s.dur
  FROM sched_slice AS s
  JOIN thread AS t USING (utid)
  JOIN process AS p USING (upid)
  WHERE s.dur > 0
    AND (
      p.name = __PACKAGE_EXACT__
      OR p.name GLOB __PACKAGE_CHILD_GLOB__
    )
)
SELECT
  w.sample_index,
  tb.trace_start_ns,
  tb.trace_end_ns,
  sb.sched_start_ns,
  sb.sched_end_ns,
  CASE
    WHEN sb.sched_start_ns IS NULL
      OR sb.sched_end_ns IS NULL
      OR w.end_ns <= w.start_ns
    THEN 0.0
    ELSE CAST(
      MAX(
        0,
        MIN(w.end_ns, tb.trace_end_ns, sb.sched_end_ns)
          - MAX(w.start_ns, tb.trace_start_ns, sb.sched_start_ns)
      ) AS REAL
    ) / (w.end_ns - w.start_ns)
  END AS trace_coverage_ratio,
  CAST(COALESCE(SUM(
    CASE
      WHEN s.ts IS NULL THEN 0
      ELSE MAX(
        0,
        MIN(w.end_ns, s.ts + s.dur) - MAX(w.start_ns, s.ts)
      )
    END
  ), 0) AS INTEGER) AS target_sched_ns,
  COUNT(s.ts) AS target_sched_slice_count
FROM input_windows AS w
CROSS JOIN trace_bounds AS tb
CROSS JOIN sched_bounds AS sb
LEFT JOIN target_sched AS s
  ON s.ts < w.end_ns
 AND s.ts + s.dur > w.start_ns
GROUP BY
  w.sample_index,
  w.start_ns,
  w.end_ns,
  tb.trace_start_ns,
  tb.trace_end_ns,
  sb.sched_start_ns,
  sb.sched_end_ns
ORDER BY w.sample_index;
