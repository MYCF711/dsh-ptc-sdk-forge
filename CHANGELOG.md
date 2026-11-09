# Changelog

## Unreleased

### Added

- Add one ordinary `ptc_sdk` tool with `discover`, `validate`, `test`, `save`, `list`, `get`, `run`, and `archive` actions.
- Run programs through a private official `PtcExecutor` without replacing the caller's executor, registering a preset, or exposing saved artifacts as additional tools.
- Add a versioned JSON artifact library with complete per-revision snapshots, optimistic revision checks, cross-session reloads, and non-destructive archiving.
- Support erasable TypeScript function bodies, caller-scoped tool discovery, validated `args`, canonical JSON results, and explicit Python-runtime rejection.
- Add public CI, credential/privacy hygiene checks, and an isolated real-host compatibility probe across built-in and custom Agent compositions.

### Security and reliability

- Serialize writes with library/artifact locks, commit atomically, verify reads, and bound schemas, artifacts, revisions, results, and discovery output.
- Reject path traversal, device names, symlinks, non-regular artifact files, recursive Forge calls, invalid runtime languages, and stale revisions.
- Preserve caller tool restrictions, approvals, guards, cancellation, deferred context, and nested execution cleanup.
- Keep absolute filesystem paths and internal development evidence out of public errors and package contents.
