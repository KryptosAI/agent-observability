# Changelog

## v1.0.7 — 2026-07-24

- Add `mcpName` and `server.json` for MCP Registry publication

## v1.0.6 — 2026-07-23

- Expand npm keywords for better discoverability
- Keyword-rich package description

## v1.0.5 — 2026-07-22

- Fix database path to `~/.agent-observability`
- Add postinstall hook for zero-touch onboarding

## v1.0.4 — 2026-07-21

- Fix `demo --port` flag
- Setup command creates config files for users without a detected agent

## v1.0.3 — 2026-07-20

- Pre-loaded demo session showing a real agent trace
- Auto-open browser on dashboard start
- Polished empty state for no sessions

## v1.0.2 — 2026-07-19

- Zero-friction onboarding with `agent-obs setup`
- Auto-detects opencode, Claude Code, and Cursor
- Configures MCP automatically — no manual editing needed

## v1.0.1 — 2026-07-18

- Automatic self-reporting via MCP server
- Session cleanup for stale sessions (>1 hour idle)
- Claude Code and Cursor integration docs
- Proxy mode deprecated in favor of native MCP self-reporting

## v1.0.0 — 2026-07-17

- First major release
- Self-reporting protocol: start_session, log_tool_call, end_session
- Integration docs for opencode, Claude Code, Cursor
- CLI: `check`, `stats`, `inspect` commands
- 6 MCP tools: start_session, log_tool_call, end_session, get_last_session, check_session, get_session_stats
- Local dashboard at localhost:9400
- SQLite storage in `~/.agent-observability/`
