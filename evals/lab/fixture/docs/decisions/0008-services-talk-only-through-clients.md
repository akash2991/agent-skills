# ADR-0008: Services talk only through clients

Status: accepted, 2026-09-28.

A service reads or writes another service's data only through the typed client the owning service defines and maintains (`contentos/services/<owner>/client.py`). No service queries another service's tables, imports another service's `persistence` module, or joins across service tables. There is no allowlist.
