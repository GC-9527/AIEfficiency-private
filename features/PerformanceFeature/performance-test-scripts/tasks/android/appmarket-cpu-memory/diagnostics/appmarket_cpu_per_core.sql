-- Run in Perfetto UI Query or trace_processor_shell.
-- 100% in avg_utilization_pct_of_this_core means the app occupied that
-- logical core for the whole trace. The process can migrate between cores.

WITH target_sched AS (
  SELECT s.cpu, s.dur
  FROM sched AS s
  JOIN thread AS t USING (utid)
  JOIN process AS p USING (upid)
  WHERE (p.name = 'com.appmarket.automotive'
         OR p.name GLOB 'com.appmarket.automotive:*')
    AND s.dur > 0
)
SELECT
  cpu,
  ROUND(SUM(dur) / 1e9, 3) AS process_cpu_seconds,
  ROUND(
    100.0 * SUM(dur) / (trace_end() - trace_start()),
    3
  ) AS avg_utilization_pct_of_this_core
FROM target_sched
GROUP BY cpu
ORDER BY cpu;

-- Overall process CPU using both conventions.
WITH target_sched AS (
  SELECT s.cpu, s.dur
  FROM sched AS s
  JOIN thread AS t USING (utid)
  JOIN process AS p USING (upid)
  WHERE (p.name = 'com.appmarket.automotive'
         OR p.name GLOB 'com.appmarket.automotive:*')
    AND s.dur > 0
),
logical_cpu_count AS (
  SELECT COUNT(DISTINCT cpu) AS value FROM sched
)
SELECT
  ROUND(SUM(dur) / 1e9, 3) AS process_cpu_seconds,
  ROUND(
    100.0 * SUM(dur) / (trace_end() - trace_start()),
    3
  ) AS cpu_one_core_equiv_avg_pct,
  ROUND(
    100.0 * SUM(dur)
      / (trace_end() - trace_start())
      / (SELECT value FROM logical_cpu_count),
    3
  ) AS cpu_device_normalized_avg_pct
FROM target_sched;
