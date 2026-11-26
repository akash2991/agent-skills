# kreate-mini

A two-service Python monorepo.

- `contentos/services/catalogue/`: posts.
- `contentos/services/jobs/`: jobs; exposes `GET /jobs/{id}` (see `contracts/kreate.openapi.yaml`).
- `web/src/jobs.ts`: the web client's decoder for `GET /jobs/{id}`.
- `docs/decisions/`: architecture decision records.

Run the tests with `python -m pytest -q` from the repository root.
