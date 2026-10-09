# T08 execution checklist

## Files to touch
- [x] `src/server/dot-agent.ts` — readiness gate no longer requires `intelligenceKey`; channel-bind title uses constructor-provided `channelLabel`; `clone()` carries the label.
- [x] `tests/dot-agent-channel.test.ts` — covers runs without an `intelligenceKey`, custom channel labels, and clone label retention.
- [x] `data/opendots-intelligence-free-plan/artifacts/T08-checklist.md` — required execution evidence.

## Ordered steps
1. [x] Inspected `DotAgent` constructor, `clone()`, channel-bind/readiness logic, `check()`, and existing dot-agent tests.
2. [x] Removed `intelligenceKey` from the readiness gate; `apiKey` and `model` remain required.
3. [x] Added `channelLabel` defaulting to `Channel conversation`, used it for new channel-thread binds, and carried it through `clone()`.
4. [x] Left the interval-based `check()` abort-on-settings-change behavior unchanged.
5. [x] Added the three planned tests for no-Intelligence run, custom channel label, and clone label retention.
6. [x] Ran the verification commands below.

## Acceptance criteria
- [x] A run proceeds with `apiKey` and `model` configured and `intelligenceKey` absent.
- [x] Existing `check()` logic is unchanged.
- [x] A first-seen channel thread binds with the supplied label, not `Slack conversation`.
- [x] `clone()` retains the channel label.

## Verification commands
- [x] `npm run typecheck && npm run lint && npm test` — passed (typecheck and lint clean; 51 test files, 336 tests passed).
- [x] Narrow check `npx vitest run tests/dot-agent-channel.test.ts` — passed (11 tests).

## Out of scope
- [x] `learnedSkills` wiring unchanged; no T03 runner, T02 store, or T04 platform wiring changes.
- [x] No push or PR opened by this worker.
