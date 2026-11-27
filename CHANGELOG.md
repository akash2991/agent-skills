# Changelog

Every version of the brain a project can install, newest first. The version is `version` in `package.json` and follows semver: major when a project must act, minor when something is added, patch for fixes and rewording. The rules are in the brain repository's `AGENTS.md`, under "Versioning and changelog".

## 1.0.0 - 2026-11-28

### Added
- FAC-52 — The brain has a version and this changelog. `agent-brain pull` records the version in `.agent-brain/install-state.json`, installs the changelog at `.agent-brain/CHANGELOG.md`, and prints the versions and the changes between them. `agent-brain status` shows the installed version, how far it is behind, and the brain files edited since the install. Everything the brain shipped before this is the 1.0.0 baseline.
