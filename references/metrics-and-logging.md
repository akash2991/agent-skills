# Metrics and Logging

Staff engineers instrument what they ship. Metrics are required because technology, product, and business each need to see the feature working; logging is restrained because noise hides signal. Instrumentation is part of the task, not a follow-up. The observability *stack* (dashboards, alerting infrastructure) is built only when in scope; emitting the metrics is always in scope.

## Metrics: three audiences, all required

| Audience | What to emit | Examples |
|---|---|---|
| Technical | Rate, errors, duration, saturation for every new endpoint, job, or external call | `http_requests_total{route,status}`, `job_duration_seconds`, `provider_errors_total{provider}` |
| Product | Usage events on the user actions the PRD names, with enough dimensions to build a funnel | `checkout_started`, `otp_requested`, `search_performed{result_count_bucket}` |
| Business | Counters and amounts the PRD's outcome is measured by | `orders_placed_total`, `order_value_cents`, `subscriptions_activated_total` |

The PM names the product and business metrics in the PRD; the PE places the technical ones in the LLD; the staff engineer emits all three and lists them in the PR and the report.

Rules: name metrics per the service `CONVENTIONS.md`; low-cardinality labels only (no user ids or free text); a metric that nobody will read is not added; every counter has a test or a fixture that proves it increments.

## Logging: enough, not more

Log at: request or job boundaries (start and end with ids and outcome), state transitions of domain entities, every error with the context needed to act on it, and external-call failures. Structured fields, one event per line, correlation id on every line.

Do not log: inside pure business logic, per-iteration loop progress, request or response bodies containing PII or secrets, successful reads at debug level in production paths, or anything that duplicates a metric.

The test for a log line: if it fired at 2am, would someone act on it or use it to trace the request? If not, delete it.

## In the review

The code reviewer checks: metrics present for all three audiences where the story warrants them, labels bounded, log points at boundaries and transitions only, no secrets or PII in logs, no debug noise.
