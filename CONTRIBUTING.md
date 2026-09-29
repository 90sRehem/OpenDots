# Contributing to OpenDots

OpenDots is in early development. Prefer focused changes that improve the first complete research workflow: task creation, page reading, results, scheduling, and user control.

For bugs, include the app mode, Node version, steps to reproduce, expected behavior, and actual behavior. Remove credentials and private page content from logs or screenshots.

For features, describe the user workflow before proposing an implementation. Clearly separate functioning integrations from sample fixtures and planned work. Do not add controls that appear to connect a service when no adapter exists.

Before opening a pull request:

- Add regression coverage for changes to durable jobs, permissions, cancellation, or API behavior.
- Run the repository's formatter, lint, typecheck, tests, and production build.
- Exercise changed UI behavior and check narrow-screen layouts and keyboard access.
- Update setup instructions if configuration or dependencies change.
- Keep credentials, local databases, generated test reports, and internal planning notes out of commits.

Project code is MIT licensed. Preserve applicable notices for any third-party code or assets you contribute.
