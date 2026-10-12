# Telemetry

OpenDots does not send usage or setup telemetry to CopilotKit, PostHog, or another hosted telemetry service. The CopilotKit runtime is configured with a no-op telemetry sink. Browser setup events are held only in a bounded local SQLite queue and discarded at the next flush (on startup and about every 15 seconds); they are never sent anywhere and are not retained as usage history. A local last-step marker can persist for abandonment recovery. No telemetry identity or sampling variables are required.

`DO_NOT_TRACK=true|1` or `COPILOTKIT_TELEMETRY_DISABLED=true|1` disables setup-event collection and clears its pending state. These settings do not affect conversations, transcripts, or workspace data.

The local event schema and route are covered by `tests/setup-telemetry.test.ts`. Runtime egress is covered by `tests/telemetry.test.ts` and the no-Intelligence runtime regression test. These checks intercept network calls and must not send events to a hosted service.
