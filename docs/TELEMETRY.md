# OpenDots usage tracking

OpenDots uses the CopilotKit SDK's existing telemetry transport. There is no
separate PostHog SDK or PostHog key to configure in this application. OpenDots
does not create accounts or sync with any hosted account service; a local
install runs without one.

## Configure the server

Telemetry is enabled by default. Remove old deployment settings that disable
it if tracking is desired.

`CPK_TELEMETRY_ID` is optional. When it is set, the SDK uses it as the telemetry
identity, so events from this server group under that CLI-issued value. When it
is unset, OpenDots uses a random installation ID that it stores in its database.
Keep the identity server-side. Do not generate your own identity or reuse another
project's value. Leave `OWNER_ID` and conversation/thread IDs unchanged; they
scope app data and are not telemetry identities.

Docker Compose forwards `CPK_TELEMETRY_ID` from `.env` into the app container.
For other deployment environments, set the same variable in the server
environment and restart the server.

The SDK sends existing runtime events to
`https://telemetry.copilotkit.ai/ingest`. OpenDots adds
`accessibility_title: "OpenDots"`. The current SDK defaults to full sampling
(`1`), and Docker Compose uses the same default. An explicit
`COPILOTKIT_TELEMETRY_SAMPLE_RATE` override is respected.

To opt out, set either `COPILOTKIT_TELEMETRY_DISABLED=true` or `DO_NOT_TRACK=1`
and restart the API. Both variables accept `true` or `1`. The `npm test` command
disables telemetry for ordinary automated fixtures.

Browser setup events are a separate flow; see
[browser setup telemetry](SETUP-TELEMETRY.md).

## What the events measure

- `oss.runtime.instance_created`: the OpenDots runtime handler was created.
- `oss.runtime.copilot_request_created`: a request reached the runtime; this is
  usage evidence, not proof of a successful model answer.

Both events carry a `telemetry_id` property: the CLI identity when
`CPK_TELEMETRY_ID` is set, otherwise the installation ID. Use it to group events
from one installation.

## Validate in PostHog

After deploying, restart the API and make one chat request. In
[PostHog project 26816](https://eu.posthog.com/project/26816), run:

```sql
SELECT event, timestamp, distinct_id,
       properties.accessibility_title AS app,
       properties.telemetry_id AS telemetry_id
FROM events
WHERE event IN (
    'oss.runtime.instance_created',
    'oss.runtime.copilot_request_created'
  )
  AND properties.accessibility_title = 'OpenDots'
  AND timestamp >= now() - INTERVAL 1 DAY
ORDER BY timestamp DESC
LIMIT 20
```

Confirm the tag and the expected `telemetry_id`. An HTTP `202` from ingest alone
does not prove PostHog delivery. If the events are missing, check the deployed
server environment and the `TelemetrySinkIngest` / `TelemetrySinkFanout`
CloudWatch logs.

## Reporting queries

The saved [daily usage query](telemetry/opendots-usage.hogql.sql) counts request
attempts and distinct telemetry identities per day, excluding marked validation
probes. The [setup-event query](telemetry/opendots-setup.hogql.sql) and
[installation conversion query](telemetry/opendots-setup-conversion.hogql.sql)
report the [browser setup flow](SETUP-TELEMETRY.md). Request counts are attempts,
including requests rejected by the SDK; they are not successful answers.

Earlier production validation covered account attribution, which OpenDots no
longer performs. Repeat the PostHog check above after deploying before relying
on these queries.

## Local verification

`npm test` disables production telemetry for ordinary fixtures. The telemetry
tests start fresh processes, intercept SDK fetch calls before importing it, and
check the OpenDots tag, the CLI-issued identity header, full sampling, the
explicit sampling override, and both opt-outs. These checks prove the local SDK
contract. Production delivery requires the PostHog check above.
