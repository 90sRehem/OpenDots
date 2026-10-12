# Browser setup events

OpenDots accepts a bounded set of setup events. The events cover setup-step views, abandonment, activation after a successful assistant response, and closed failure categories. They contain no prompts, answers, raw errors, credentials, URLs, file paths, model names, or owner IDs.

The authenticated `/api/setup-telemetry` route accepts only strict step-view and abandonment objects. It rejects unknown keys, invalid steps, arbitrary properties, client-forged activation/failure, and readiness inconsistent with server state. Existing owner-token, origin, cross-site, content-type, and body-size guards apply. Settings visibility does not expose environment configuration values.

Local state uses a random installation UUID and a bounded queue of at most 256 events. Setup events have no transport, so the queue is discarded rather than retained or sent to a hosted telemetry service. The CopilotKit runtime uses a no-op telemetry sink, so chat, scheduled work, and Telegram do not transmit usage metadata to CopilotKit. `DO_NOT_TRACK=true|1` or `COPILOTKIT_TELEMETRY_DISABLED=true|1` disables setup-event collection and clears its pending queue.

Local regression coverage includes offline persistence, queue bounds, opt-outs, recovered abandonment, activation deduplication, agent success/startup failures, assistant-role gating, timeout/abort suppression, schema rejection, and authenticated origin-protected routing. Run the focused tests with:

```sh
DO_NOT_TRACK=1 npm exec vitest run tests/setup-telemetry.test.ts tests/dot-agent-channel.test.ts tests/telemetry.test.ts tests/app.test.ts
npm run typecheck
```
