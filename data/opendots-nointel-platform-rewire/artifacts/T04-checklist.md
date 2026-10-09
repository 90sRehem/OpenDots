# T04 implementation checklist

## Files and plan realization

- [x] `src/server/platform.ts`: removed the Intelligence instance and Slack channel wiring; owns the injected `ConversationStore`; constructs `ConversationRunner` and an SSE `CopilotRuntime` with `runner` only; uses local thread binding and durable message history; uses a store-backed `PageIntelligence` adapter; keeps runtime scope validation unchanged; setup excludes Intelligence from readiness while preserving model-key/model-id gates.
- [x] `src/server/platform-config.ts`: unchanged; Intelligence fields and env readers remain for deferred callers.
- [x] `src/server/channel-errors.ts`: added the generic safe failure formatter and channel failure reporter.
- [x] `src/server/slack-channel.ts`: deleted Slack-specific implementation after moving the generic helpers.
- [x] `src/server/index.ts`: imports the moved helpers and creates `ConversationStore(database)` using the existing `DATABASE_PATH`, passing it to `Platform`.
- [x] Tests: added platform readiness/local persistence/page-adapter tests and channel-error tests; updated constructor and telemetry/page-route tests; removed Slack-channel tests for the deleted connector.
- [x] `data/opendots-nointel-platform-rewire/artifacts/T04-checklist.md`: this execution checklist.

## Ordered steps executed

1. [x] Inspected the listed platform/config/index/channel/scope/runner files and the revised execution brief.
2. [x] Relocated `safeFailure` and `reportChannelFailure`; shutdown reporting still uses the same helpers and output.
3. [x] Removed Intelligence construction and Slack managed-channel runtime wiring.
4. [x] Left `platform-config.ts` unchanged as revised.
5. [x] Added the durable conversation store at the existing database path and injected it into `Platform`.
6. [x] Constructed `ConversationRunner` and passed it to `CopilotRuntime` without Intelligence or channels.
7. [x] Changed conversation creation/history to local workspace binding and durable store reads.
8. [x] Added the store-backed page thread/history adapter, unwrapping stored AG-UI message content.
9. [x] Kept the handler available without an Intelligence key and preserved `validateRuntimeScope` checks.
10. [x] Removed Intelligence from platform readiness while retaining fail-closed model setup checks.
11. [x] Deleted Slack-specific module code.
12. [x] Added/updated tests and ran the prescribed verification.

## Acceptance evidence

- [x] `rg -i 'CopilotKitIntelligence' src/server/platform.ts` returns no matches.
- [x] Runtime construction uses the T03 runner; no `intelligence` or `channels` option is supplied.
- [x] `Platform` runtime responds to `/api/copilotkit/info` with HTTP 200 and SSE mode without Intelligence configuration.
- [x] Tests prove setup reports no missing Intelligence key and remains blocked by missing `OPENAI_API_KEY` or `OPENAI_MODEL`.
- [x] Tests prove conversation binding/history and saved page content use the durable conversation store.
- [x] Generic shutdown error helpers retain safe formatting and logging behavior after relocation.
- [x] Full end-to-end agent conversation without `INTELLIGENCE_*` configuration remains deferred as specified; `dot-agent.ts` is unchanged and still gates on the Intelligence key.

## Verification

- [x] `npm run typecheck && npm run lint && npm test` — passed; 51 test files, 331 tests.
- [x] Manual no-Intelligence platform smoke: launched an in-memory `Platform` under `OPENAI_API_KEY=fixture`, `OPENAI_MODEL=fixture`, with `INTELLIGENCE_*`, `CPK_*`, and `SLACK_*` variables unset; `requireReady()` succeeded, `setup().missing` was empty with `intelligence: false`, and `/api/copilotkit/info` returned HTTP 200.
