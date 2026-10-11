# Running the template

OpenDots runs a React app and a Node server. The server stores pages, Space and Dot configuration, and thread bindings in SQLite and connects to your configured model provider and messaging services.

## Local development

Use Node.js 24 and npm.

```sh
npm ci
cp .env.example .env
npm run dev
```

Open http://127.0.0.1:5173. The API runs on port 4310. Without service credentials, the app shows its setup state; it does not generate simulated replies.

During `npm run dev`, both http://localhost:5173 and http://127.0.0.1:5173 are allowed browser origins. The UI sends API requests through Vite's `/api` proxy. To use a different proxy or custom domain, set `APP_ORIGIN` to one exact origin or a comma-separated list, for example `APP_ORIGIN=http://localhost:5173,http://127.0.0.1:5173`. An explicit value replaces the development defaults. Origins must match the scheme, hostname, and port exactly; omit paths and trailing slashes. Whitespace around list entries is trimmed and empty entries are ignored. Outside development, leaving `APP_ORIGIN` unset requires the browser origin to match the request URL's origin. This setting preserves cross-site request blocking; it does not enable direct cross-origin browser access to the API.

For a built local app:

```sh
npm run build
npm start
```

Open http://127.0.0.1:4310. Keep the server running for background work.

## Connection settings

Text conversations need only a model provider. Edit `.env` on the server and restart after changes:

| Variable                         | Purpose                                                                  |
| -------------------------------- | ------------------------------------------------------------------------ |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Model credential and model identifier                                    |
| `OPENAI_BASE_URL`                | Compatible model API endpoint                                            |
| `OWNER_ID`                       | Stable identity used for this deployment's conversations                 |
| `DATABASE_PATH`                  | SQLite file containing pages, conversations, workspace and work metadata |
| `OWNER_TOKEN`                    | Application access token; required for external bindings                 |
| `APP_ORIGIN`                     | Comma-separated exact browser origins for a proxy or custom domain       |

The model environment variable names follow the configured provider adapter. Provider credentials belong in `.env`, not client-side variables or source code. See [Data and privacy](../README.md#data-and-privacy) for where conversation history and SQLite data are stored.

## Pages and page conversations

Select a Space to open its page library. Search for a document, switch between grid and list views, or create a new page. The visual editor supports formatting, headings, lists, checklists, tables, and slash commands. Use `/` to insert a block and Cmd/Ctrl+S to save immediately. Pages autosave after editing pauses; the save status tells you whether changes reached the server.

Page actions include creating subpages, moving a page within its Space, deleting a page (its subpages move up to the deleted page's parent), and editing Markdown source. Existing documents with unsupported visual-editor syntax stay in source mode to preserve their content. Manual editing works without conversation credentials.

Open a page's chat and choose a specialist with access to that Space. Grant access from the Dot’s settings in the sidebar. The server creates or reuses a local thread for that page and specialist. The Dot receives the current saved page as context and can read, create, and edit pages in its authorized Spaces. The page conversation uses that page’s Space by default; other chats use the Dot’s default page destination. Save your manual edits before asking it to revise the document. Revision checks reject stale writes; a conflict keeps your local draft available for recovery. Failed saves stop automatic retries until you retry or resolve the conflict, so a disconnected session does not silently replace newer content.

Use the conversation's save-to-page action to create a document from its saved text history. This requires a working conversation service. Pages retain a link to the source conversation, and page links in chat open the document workspace.

Back up the SQLite database: it contains page content, thread bindings, and conversation history. The template does not include multi-user page sharing, realtime collaboration, file uploads, or arbitrary interactive embeds.

## Public-web search and browser reader

Public-web search runs through a self-hosted [SearxNG](https://docs.searxng.org/) instance that you operate. Run it on loopback or a private host, enable its JSON output in `settings.yml`, then point OpenDots at it:

```yaml
search:
  formats:
    - html
    - json
```

```sh
SEARXNG_URL=http://127.0.0.1:8080
```

OpenDots sends search queries only to `SEARXNG_URL` and returns result titles, snippets, and source URLs as citations. It does not fetch result pages, so search-based research works from snippets. Use the browser reader below to read one supplied page. Compose deployments must set `SEARXNG_URL` to an address the app container can reach. See [public-web research](../README.md#public-web-research) for data sharing, permissions and limitations.

`WEB_SEARCH_PROVIDER` selects `searxng`, `exa`, `browser` (the URL-only reader), or `disabled`. When it is unset, OpenDots chooses `searxng` if `SEARXNG_URL` is set, `browser` if `BROWSER_URL` and `BROWSER_SECRET` are set, and `disabled` otherwise. Exa is never chosen automatically. With nothing configured, search reports itself unavailable and the rest of the app works normally. Selecting `searxng` without `SEARXNG_URL`, or `exa` without `EXA_API_KEY`, also reports search unavailable. The former third-party provider value `parallel` is rejected at startup.

### Optional Exa search

Exa is an opt-in third-party search provider. It is used only when you set both `WEB_SEARCH_PROVIDER=exa` and your own `EXA_API_KEY` on the server:

```sh
WEB_SEARCH_PROVIDER=exa
EXA_API_KEY=your-exa-key
```

Search queries are sent to `https://api.exa.ai/search` with that key. Exa returns the same kind of result as SearxNG: titles, highlights, and source URLs, mapped to the same citation shape, so research output does not depend on the provider. Exa's page highlights are excerpts; OpenDots does not fetch the pages. Keep the key in `.env` only, never in client code or source control.

The browser service reads a supplied public URL and returns page text and a capture. Configure `BROWSER_URL` and `BROWSER_SECRET`, then run:

```sh
npx playwright install chromium
npm run browser
```

Use the same secret on the app and browser processes. Browser navigation is read-only with JavaScript disabled. Private addresses, redirects, and authenticated pages are unsupported; provide a canonical public URL. This is a bounded research tool, not a general desktop or shell.

## Persistent Dot computers

For a separate browser, persistent files, and optional shell for each specialist, follow [Computer setup](COMPUTERS.md). This uses pinned OpenBot computer/supervisor services and per-Dot permissions. Search tools remain available alongside configured computer tools. With the browser provider selected, Dots use their computer tools in place of the read-only public-page tool; enable each Dot's required capabilities before use.

## Telegram

OpenDots connects to Telegram through the Bot API. The server polls Telegram from inside its own process, so no webhook, public address, or app review is needed. The bot answers one owner: that owner's private chat, plus any extra numeric user ids you allow. Group chats and channels are ignored.

### Create the bot

1. In Telegram, open [@BotFather](https://t.me/BotFather), send `/newbot`, and choose a display name and a username ending in `bot`.
2. BotFather replies with a bot token shaped like `123456:ABC...`. Treat it as a password. Put it only in the server's `.env`. Do not paste it into chat, a browser, a screenshot, or a commit.

### Find your numeric user id

`TELEGRAM_OWNER_ID` is your numeric Telegram user id, not your username or phone number. Find it before starting OpenDots, because the connector and these lookups read the same update queue:

- Message a "get my id" bot, which replies with your id, or
- Send any message to your new bot, then open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read `message.from.id`. That URL contains the token, so do not share it.

### Configure OpenDots

Set these in the server's `.env`:

```dotenv
TELEGRAM_BOT_TOKEN=123456:REPLACE_WITH_BOTFATHER_TOKEN
TELEGRAM_OWNER_ID=REPLACE_WITH_YOUR_NUMERIC_ID
TELEGRAM_ALLOWED_IDS=
TELEGRAM_DOT_ID=
```

| Variable               | Purpose                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `TELEGRAM_BOT_TOKEN`   | Bot token from BotFather. Required with the owner id. A server-side secret: never logged or sent to the browser. |
| `TELEGRAM_OWNER_ID`    | Required. The owner's numeric Telegram user id.                                                                  |
| `TELEGRAM_ALLOWED_IDS` | Optional. Extra numeric Telegram user ids, comma-separated.                                                      |
| `TELEGRAM_DOT_ID`      | Optional. An existing Dot id, from the authenticated `/api/workspace` response. Defaults to the first Dot.       |

Restart OpenDots after changing these settings. Settings & setup shows the Telegram status:

- **not configured**: no Telegram variable is set. Nothing else is affected.
- **setup required**: a variable is missing or malformed, or the connector has not started yet.
- **online**: Telegram confirmed the token and the connector is polling.
- **activation failed**: Telegram rejected the token or could not be reached. Check the token and network access, then restart.

### Conversation behavior

Only a private chat from the owner or an allowed user can start an agent run. Everything else is dropped without a reply: group messages, edited messages, channel posts, bot senders, and anyone not listed. Each private chat is one local conversation bound to the selected Dot, and it continues across restarts. If OpenDots stops during a reply, the owner receives a notice asking them to resend. After a restart, polling resumes from the stored position, so updates that were already handled are not replayed.

Telegram bot chats are not end-to-end encrypted, and replies are visible to anyone who can read the chat. The template maps every permitted Telegram user to the single OpenDots owner. It is not a multi-user identity model.

### Verify your deployment

1. From the owner's account, send a message to the bot. Expect a reply in the same chat. This needs `OPENAI_API_KEY` and `OPENAI_MODEL`.
2. From an account that is not `TELEGRAM_OWNER_ID` or in `TELEGRAM_ALLOWED_IDS`, message the bot. Expect no reply and no new conversation in OpenDots.
3. Add the bot to a group and message it there. Expect no reply.
4. Restart OpenDots, then send another message from the owner's account. The reply should continue the same conversation without a resend notice.

Automated tests exercise the connector with fixtures. These steps need your own bot token and a live Telegram account, so they are not covered by `npm test`.

## Calls

The included speech adapter uses the Realtime API at `api.openai.com`. Set `VOICE_API_KEY` to a key with access to that API and `VOICE_MODEL` to a supported Realtime model (the local UI test used `gpt-realtime-2.1`); `VOICE_NAME` selects the voice. `OPENAI_BASE_URL` changes the compute model endpoint only, not speech. Calls use browser microphone access and WebRTC. Deployments reached over a network need HTTPS. The server mediates provider setup and delegates compute to the selected Dot's conversation.

A configured key is not evidence of a successful call. Verify microphone access, audio playback, compute delegation, interruption, hangup, and the saved receipt with your deployment before relying on voice workflows.

## Containers

Set `OWNER_TOKEN` and `BROWSER_SECRET` to different random secrets of at least 24 characters in `.env`, then run:

```sh
docker compose up --build -d
```

Open http://localhost:4310. The app port binds to loopback. The browser service is optional: set a 24+ character `BROWSER_SECRET` and run `docker compose --profile browser up --build` to enable it; it has no published port. Application metadata lives in the `opendots-data` volume. The bundled compose file forwards the `TELEGRAM_*` settings from `.env`, so the connector runs in the container when they are set.

```sh
# Stop services while retaining saved data.
docker compose down
```

For remote access, configure an HTTPS reverse proxy and the matching `APP_ORIGIN`. See [Security](../SECURITY.md) for the template's deployment boundary.

## Automatic Learning

Automatic Learning runs locally. Lessons are stored in the local OpenDots
database, and nothing is sent to a remote service. The workspace database stores
proposed skills, each version's review state, and the approved library a Dot
delivers. No remote skill catalog or external credential is on the delivery
path.

Each Dot owns its library. The **Automatic Learning** settings in the Dot dialog
control local delivery:

- **Learn from future conversations** enrolls the Dot in learning from new work.
  Only conversations started after you turn it on are used; old conversations are
  not scanned. Automatic suggestions are unavailable until a local model is
  connected, so none appear yet.
- **Use approved lessons** uses this Dot's approved lessons in new turns.
  Turning it off stops their use without deleting them. Delivery also requires
  the workspace and Dot **Memory** permissions.
- **Review lessons** opens the review screen, where the owner lists, reads,
  writes, approves, rejects, edits, retires, and restores lessons. The owner can
  also mark one of their own completed web-app turns and propose a lesson from
  it. A lesson proposed from a turn or saved as an edit is scanned first: hard
  findings refuse the save, and soft findings store it quarantined, where it
  cannot be approved until the owner edits it.

On each new turn, OpenDots adds the Dot's approved catalog to the system prompt
and exposes the application-owned, read-only `load_local_skill` tool. The model
decides which relevant skills to load, up to two bodies per turn. Check the run's
tool calls to verify actual use; saving settings alone does not load anything.

Only an active, approved version enters a catalog. Pending, quarantined, and
rejected versions never appear in a catalog and cannot be loaded. Approval is
compare-and-swap against the content hash, evidence digest, and active pointer
the reviewer saw: any change refuses the approval, and an edited proposal must be
reviewed again. Retiring a version removes it from delivery immediately;
restoring re-activates one exact retired version only when nothing else is
active. OpenDots does not automatically approve skills.

Conversation learning enrollment is fixed when the conversation is created;
existing conversations are not enrolled retroactively. This applies to page chat,
scheduled and voice compute in those conversations, and new Telegram
conversations.
Existing research, memory, page, and computer permissions still apply. Ingestion
and delivery are separate: turning off delivery does not stop evidence
collection. When delivery is off, the turn continues without a catalog.

A delivery, permission, or active-library change bumps the Dot's learning
revision. In-flight snapshots stop loading, and a revoked learned body is
replaced with a marker before it can reach the model again, so it cannot be
replayed. Uncheck **Use approved lessons** to continue without skills.

Two automatic signals queue an extraction, and only for a completed web-owner
turn that has a direct owner message, on a thread enrolled for learning while
the Dot still allows learning. A correction cue in your own message, such as
"não faça", "prefiro", "instead", or "remember this", queues one extraction for
that turn. A repeated workflow queues the newest turn when it and another
eligible turn of the same Dot in the last seven days call the same tools in the
same order, at least three calls, comparing up to the 20 most recent eligible
turns. Only hashed tool names are compared, and tool
arguments are never read. Cues are a cheap recall heuristic, not a judgement of
what you meant. Channel, voice, scheduled, failed, and interrupted turns never
queue one, and a failed signal check never fails the chat.

Automatic extraction is optional. Set `LEARNING_EXTRACTOR_URL` to an
OpenAI-compatible endpoint on `http://127.0.0.1` or `http://[::1]` (no URL
credentials, no redirects) and `LEARNING_EXTRACTOR_MODEL` to the model it
serves. OpenDots makes at most one tool-free call at a time, only when no
foreground turn is running. The owner's pause cancels a running extraction, and
revoked learning or memory permission cancels it and any queued work. Extraction
never falls back to `OPENAI_BASE_URL`. Without a usable endpoint, extraction is
shown as unavailable and manual authoring still works. An extracted lesson is
only ever a pending or quarantined proposal, and it cannot activate without
review.

The endpoint must be loopback, so a containerized server can only reach an
extractor that shares its network namespace, such as one running in the same
container or one reached through host networking. An extractor listening on
`127.0.0.1` on the Docker host is not reachable from inside the `app` container,
and a different container IP is refused because it is not loopback. The bundled
compose file forwards `LEARNING_EXTRACTOR_URL` and `LEARNING_EXTRACTOR_MODEL`
from `.env` when they are set.

## Development checks

```sh
npm run check-format
npm run lint
npm run typecheck
npm test
npm run build
```

Automated tests use service fixtures. Live model, Telegram, and voice verification requires your own configured services and bot token.
