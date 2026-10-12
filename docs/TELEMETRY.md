# Telemetry

OpenDots does not send usage or setup telemetry to CopilotKit, PostHog, or another hosted telemetry service. The CopilotKit runtime is configured with a no-op telemetry sink. No telemetry identity or sampling variables are required.

`DO_NOT_TRACK=true|1` or `COPILOTKIT_TELEMETRY_DISABLED=true|1` disables setup-event collection and clears its pending state. These settings do not affect conversations, transcripts, or workspace data. Browser setup events stay local; see [browser setup events](SETUP-TELEMETRY.md) for their lifecycle and retention.

The local event schema and route are covered by `tests/setup-telemetry.test.ts`. Runtime egress is covered by `tests/telemetry.test.ts` and the no-Intelligence runtime regression test. These checks intercept network calls and must not send events to a hosted service.
