# Security

OpenDots is an early single-owner application. It is not a multi-tenant hosting platform or a security-audited autonomous agent.

## Intended boundary

- Run local development on loopback.
- Protect remote deployments with authentication and HTTPS.
- Keep the browser service isolated from the application host and private networks. Do not expose its port publicly.
- Keep model keys and browser credentials on the server. Never commit `.env` files or local databases.
- Treat page text, uploaded content, and model output as untrusted data, not authorization to change permissions.
- The initial research workflow is read-only. Adding external writes requires a separate authorization and review design.

Recurring work requires an available server. A sample run is not evidence that a live provider or deployment is safe or configured correctly. Review results before using them for important decisions.

## Reporting

Use the repository's private vulnerability reporting feature when available. If it is unavailable, open an issue asking for a private reporting channel without including exploit details, credentials, private URLs, or personal data.

Do not post sensitive reproduction data in a public issue. This project does not currently promise a response-time SLA or offer a bug bounty.
