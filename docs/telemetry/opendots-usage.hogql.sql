-- Request attempts and distinct telemetry identities per day, excluding validation probes.
-- A request counts as an attempt even when the SDK rejects it; it is not a successful answer.
SELECT toDate(timestamp) AS day,
       count() AS request_attempts,
       uniqExactIf(telemetry_id, notEmpty(telemetry_id)) AS telemetry_identities
FROM (
  SELECT timestamp, toString(properties.telemetry_id) AS telemetry_id
  FROM events
  WHERE event = 'oss.runtime.copilot_request_created'
    AND properties.accessibility_title = 'OpenDots'
    AND timestamp >= now() - INTERVAL 30 DAY
    AND empty(toString(properties.validation_run_id))
)
GROUP BY day
ORDER BY day
