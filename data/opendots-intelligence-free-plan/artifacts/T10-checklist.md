# T10 execution checklist

## Files to touch

- [x] `src/server/telegram-channel.ts` — self-contained polling, admission, run, reply, retry, and restart connector.
- [x] `src/server/conversation-store.ts` — only the authorized additive `admitInboundTurn` method; atomically inserts the inbound row, message, run, and start event and returns `null` on the inbound uniqueness conflict.
- [x] `tests/conversation-store.test.ts` — atomic admission and duplicate verdict coverage.
- [x] `tests/telegram-channel.test.ts` — fake Telegram endpoint coverage.

## Ordered steps

1. [x] Read the channel error helper, conversation store, workspace, conversation runner, and available channel patterns. No separate Slack connector exists in this checkout.
2. [x] Add one transactional inbound-turn admission method, leaving the rest of the store unchanged.
3. [x] Add the connector constructor with token, owner, allowlist, store, workspace, agent factory, and paused predicate.
4. [x] Poll Telegram `getUpdates` using native fetch and the durable high-water offset.
5. [x] Apply a named private-human-message eligibility predicate; silently drop other update types.
6. [x] Bind/require local Telegram threads and use atomic admission for accepted updates.
7. [x] Deliver through outbound rows with a three-attempt cap and Telegram `sendMessage`.
8. [x] Keep the token in an ECMAScript private field, sanitize request failures, and verify no console or `SetupTelemetry` capture leaks it.
9. [x] Recover interrupted runs with one resend notice and resume from the stored offset; no route or webhook added.
10. [x] Test fake endpoint failures, rejected update categories, allowlisted messages, redelivery, pre-commit crash redelivery, restart history/offset, and store atomicity.
11. [x] Ran the real-bot over-limit probe. The API returned `Bad Request: chat not found`, so it did not settle the message-length limit; a read-only `getUpdates` check found zero pending updates and no prior private message from the configured owner. No chunking behavior was inferred or added.
12. [x] Run the requested typecheck, lint, and full test suite.

## Acceptance criteria

- [x] Request-failure tests verify the token is absent from captured stdout/stderr, outbox data, and `SetupTelemetry` capture calls.
- [x] Rejected update-type tests verify no reply, model run, or thread creation; additional unauthorized, group, and bot-message cases are covered.
- [x] An allowlisted private message is durably admitted, runs, and replies to the same chat.
- [x] Duplicate update ids yield one run and one send; outbound failures are capped at three attempts.
- [x] Injected failure before atomic admission leaves the offset untouched; redelivery yields one run. Restart resumes at high-water + 1 and preserves history.
- [ ] Real-bot chunking limit remains unsettled: the real API request was attempted but the configured bot has no accessible private chat with the owner.

## Verification commands

- [x] `npm run typecheck` — passed.
- [x] `npm run lint` — passed.
- [x] `npm test` — passed (52 files, 349 tests).
- [x] `git diff --check` — passed.
- [x] Real Telegram API probe — attempted; inconclusive because the configured bot has no private chat with the owner.

## Real-bot experiment evidence

Credential values were read directly from `/home/rehem/Projects/squad/config/telegram-bot-token` at runtime and were not printed or copied. The commands below contain no credential values.

First command (POST a 4097-character ASCII probe to the configured owner chat):

```sh
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const config = Object.fromEntries((await readFile('/home/rehem/Projects/squad/config/telegram-bot-token', 'utf8'))
  .split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
const token = config.TELEGRAM_BOT_TOKEN;
const chatId = config.TELEGRAM_OWNER_ID;
try {
  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: 'x'.repeat(4097) }),
    signal: AbortSignal.timeout(20000),
  });
  const result = await response.json();
  console.log(JSON.stringify({ http_status: response.status, ok: result.ok, error_code: result.error_code, description: String(result.description ?? '').split(token).join('[REDACTED]') }));
} catch {
  console.log(JSON.stringify({ error: 'Telegram request failed; details withheld' }));
}
NODE
```

Observed output:

```text
{"http_status":400,"ok":false,"error_code":400,"description":"Bad Request: chat not found"}
```

Follow-up command (read pending updates without advancing the update offset; print no message content):

```sh
node --input-type=module <<'NODE'
import { readFile } from 'node:fs/promises';
const config = Object.fromEntries((await readFile('/home/rehem/Projects/squad/config/telegram-bot-token', 'utf8'))
  .split(/\r?\n/).filter(Boolean).map((line) => {
    const index = line.indexOf('=');
    return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
  }));
const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_OWNER_ID: ownerId } = config;
const base = `https://api.telegram.org/bot${token}`;
try {
  const response = await fetch(`${base}/getUpdates?timeout=0&allowed_updates=%5B%22message%22%5D`, { signal: AbortSignal.timeout(10000) });
  const updates = await response.json();
  const ownerMessage = (updates.result ?? []).find((update) => String(update.message?.from?.id) === ownerId && update.message?.chat?.type === 'private');
  if (!updates.ok || !ownerMessage) {
    console.log(JSON.stringify({ updates_ok: updates.ok, update_count: updates.result?.length ?? 0, owner_private_message_available: Boolean(ownerMessage), error_code: updates.error_code, description: String(updates.description ?? '').split(token).join('[REDACTED]') }));
  } else {
    const send = await fetch(`${base}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: ownerMessage.message.chat.id, text: 'x'.repeat(4097) }),
      signal: AbortSignal.timeout(20000),
    });
    const result = await send.json();
    console.log(JSON.stringify({ updates_ok: updates.ok, owner_private_message_available: true, http_status: send.status, ok: result.ok, error_code: result.error_code, description: String(result.description ?? '').split(token).join('[REDACTED]') }));
  }
} catch {
  console.log(JSON.stringify({ error: 'Telegram request failed; details withheld' }));
}
NODE
```

Observed output:

```text
{"updates_ok":true,"update_count":0,"owner_private_message_available":false,"description":""}
```
