# Agent Observability — White Paper

> v1.0 · July 2026 · [agent-obs on npm](https://www.npmjs.com/package/agent-obs) · [GitHub](https://github.com/KryptosAI/agent-observability)

---

## The Problem

AI coding agents execute dozens of tool calls per session — reading files, running commands, editing code, searching patterns. Every call burns tokens, costs money, and either succeeds or fails. But at the end of a session, the operator sees only the diff. They don't know:

- How many tool calls were made
- Which calls failed and why
- What the session cost in tokens and dollars
- Whether the agent chose the right tools
- Whether errors were recovered or silently swallowed

**Agents are black boxes.** Their output is visible but their process is invisible. This creates three problems:

1. **Cost blindness.** An agent that could solve a problem in 5 tool calls might take 50. The operator pays 10x without knowing it.
2. **Failure forensics.** When output is wrong, there's no audit trail to trace which step failed, what error occurred, and whether the agent retried or gave up.
3. **Trust erosion.** Teams deploy agents into CI, production, and security-critical workflows without any observability into what the agent actually did.

Existing solutions monitor infrastructure (Datadog), API calls (LangSmith), or LLM quality (evals). None monitor agent execution — the sequence of tool calls, decisions, errors, and outcomes that constitute an agent session.

---

## The Solution

**Agent Observability** is an open-source, local-first tool that traces AI agent execution. Every tool call, every error, every token consumed — recorded, graded, and made searchable in a local dashboard.

### How It Works

```
┌─────────────┐     MCP protocol      ┌──────────────┐     SQLite      ┌───────────────┐
│  AI Agent   │ ──── self-reports ──→ │  agent-obs   │ ──── stores ──→ │  Dashboard    │
│  (opencode, │    every tool call    │  MCP Server  │                │  localhost:   │
│  Claude,    │                       │              │                │  9400         │
│  Cursor)    │                       └──────────────┘                └───────────────┘
└─────────────┘
```

1. **The agent connects to agent-obs as an MCP server.** No proxy, no middleware — one config line.
2. **The agent self-reports every action.** After each tool call, it calls `log_tool_call` with the tool name, duration, status, and a summary. This captures ALL tools — built-ins (Read, Write, Edit, Bash, Glob, Grep) and MCP tools alike.
3. **agent-obs stores everything locally in SQLite.** No cloud dependency. No data leaves the machine.
4. **A local dashboard shows every session.** Timelines of tool calls, error breakdowns, cost per session, grade distributions. Linear-quality, dark theme, split-panel.

### The Grade System

Every session receives an A-F grade based on error rate and tool efficiency:

| Grade | Meaning | Criteria |
|:-----:|---------|----------|
| A | Clean | Zero errors, efficient tool usage |
| B | Minor issues | Some inefficiencies, no failures |
| C | Inefficient | Redundant calls, recoverable errors |
| D | Risky | Multiple failures, wrong tool choices |
| F | Failed | Errors prevented task completion |

Grades are not punitive — they're diagnostic. A "C" session with 50 tool calls but only 2 recoverable errors tells the operator exactly where to focus their prompt engineering.

---

## Architecture

### Core Components

| Component | File | Purpose |
|-----------|------|---------|
| **MCP Server** | `mcp-server.js` | Receives self-reports from agents via JSON-RPC 2.0 over stdio. 6 tools: `start_session`, `log_tool_call`, `end_session`, `get_last_session`, `check_session`, `get_session_stats`. |
| **Database** | `database.js` | SQLite schema with sessions, tool_calls, decision_points, audit_entries, skill_loads, tool_health_checks. Local-first, zero config. |
| **Proxy** | `proxy.js` | Transparent MCP stdio proxy for passive capture. Intercepts `tools/list` and `tools/call` without agent modification. Complements self-reporting for MCP-only traffic. |
| **Dashboard** | `server.js` + `public/` | Express API + static SPA. Three tabs: Sessions list, Session trace timeline, Tool health. |
| **CLI** | `cli.js` | `agent-obs server`, `agent-obs dashboard`, `agent-obs check`, `agent-obs stats`, `agent-obs inspect <id>`. |

### The Self-Reporting Protocol

Self-reporting is the primary capture mechanism. It covers 100% of agent actions because the agent explicitly reports each one:

```
Phase 1 — start_session → creates session record, returns session ID
Phase 2 — log_tool_call × N → records every tool call with name, duration, status, input/output
Phase 3 — end_session → computes grade, finalizes session, returns summary
Anytime — get_last_session → retrieves the last session's grade and stats
```

A companion proxy mode captures MCP traffic transparently for agents that can't self-report, but it only covers MCP tools (~30% of typical agent actions). Self-reporting covers everything.

### Machine Identity

Every installation generates a persistent machine fingerprint — a SHA256 hash of platform, architecture, Node version, and home directory. In CI environments, the `GITHUB_REPOSITORY` variable is included, making the fingerprint deterministic per-repo across Docker restarts. This enables:

- **Session continuity.** Same machine, same identity across restarts.
- **CI persistence.** Same repo always resolves to the same fingerprint, even in ephemeral containers.
- **Zero PII.** The fingerprint is anonymous. No emails, no hostnames, no personal data required.

Users can optionally identify themselves via `agent-obs telemetry identify` to receive benchmarks and insights. This is strictly opt-in.

---

## Comparison to Existing Solutions

| Tool | What It Monitors | agent-obs Gap |
|------|-----------------|---------------|
| **LangSmith** | LangChain API calls, LLM traces | LangChain-only, cloud-only, no grades, no local dashboard |
| **Datadog** | Infrastructure metrics | No agent tool call tracing, enterprise pricing |
| **Sentry** | Application errors | No agent context, no session grading |
| **OpenTelemetry** | Distributed traces | No agent-specific schema, requires instrumentation |
| **agent-obs** | Agent tool calls, sessions, grades | Free, local, open source, agent-agnostic |

agent-obs is the only tool that traces agent execution end-to-end with session-level grading, local-first storage, and no vendor lock-in.

---

## Relationship to MCP Observatory

**MCP Observatory** (`@kryptosai/mcp-observatory`) secures MCP servers. **Agent Observability** (`agent-obs`) traces the agents that use them. Together they form a security + observability pipeline:

```
MCP Observatory                    Agent Observability
─────────────────                  ───────────────────
Tests MCP servers                  Traces agent sessions
Finds vulnerabilities              Logs every tool call
Generates SARIF reports            Computes A-F grades
Prevents supply chain attacks      Reveals cost per task
"Are my tools safe?"               "What did my agents do?"
```

Both tools share architectural DNA: local-first SQLite storage, Express + static dashboard, provenance-driven design, and open-core monetization models.

---

## Provenance

Agent Observability combines patterns from three KryptosAI projects:

| Source | What It Contributed |
|--------|---------------------|
| **MCP Observatory** | Tool health scoring (0-100, A-F), pass/fail gating, periodic scheduled checks, structured JSON run artifacts |
| **Veros** (FHIR clinical ground truth) | "No trace, no answer" principle — every claim must cite source evidence. Applied to agent sessions: no diagnosis without trace data. Full audit trail with permission tracking. |
| **AgentShelf** (Shopify AI readiness) | Express + SQLite dashboard architecture, split-panel layout, dynamic stat cards, grade badge rendering patterns |

---

## Open Source Model

agent-obs is MIT licensed. The core — MCP server, local dashboard, SQLite storage, CLI — is free and open source forever.

A future cloud tier (team dashboard, alerting, historical analytics, SSO) will be offered as a paid service, following the Sentry model. The local product never degrades. The cloud product adds collaboration.

---

## Roadmap

| Version | Focus | Status |
|---------|-------|:------:|
| **v1.0** | MCP server, self-reporting, dashboard, CLI, grades, fingerprints | ✓ Shipped |
| **v1.1** | Agent skill distribution (pre-built SKILL.md for opencode, Claude Code, Cursor), auto-prompt after 5 sessions | — |
| **v1.2** | Cloud tier: team dashboard, alerting, historical analytics | — |
| **v1.3** | Enterprise: SSO, audit compliance, self-hosted runner, custom retention policies | — |
| **v2.0** | Multi-agent coordination tracing, agent-to-agent handoff visibility | — |

---

## Get Started

```bash
npm install -g agent-obs
agent-obs dashboard        # http://localhost:9400
```

Add to your agent's MCP config:

```json
{
  "mcp": {
    "agent-obs": {
      "type": "local",
      "command": ["agent-obs", "server"],
      "enabled": true
    }
  }
}
```

Restart your agent. It will now self-report every action.
