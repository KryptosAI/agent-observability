# HN Show HN Post — agent-obs

Copy everything below the line into the HN submission form. Title goes in the "title" field, body in the "text" field. (HN renders plain text only — paragraphs separated by blank lines, code indented two spaces. This is intentional.)

---

## TITLE

Show HN: Agent Observability – See what your AI agents actually do, locally

## BODY

I built agent-obs because I realized I had no idea what my coding agents were actually doing.

I run Claude Code and opencode all day. I hand an agent a task — "fix the auth bug," "refactor this module" — and a few minutes later I get a diff. But what happened in between? How many files did it read? How many tool calls did it make? Did it try three approaches and abandon two? How much did that session cost? I had no answers, and nobody else I've asked does either.

The bill part bothered me most. A session that feels fast can burn $5 in tokens. A session that feels slow might cost $0.50. Without traces you're estimating cost by vibes, and when a session produces broken code you can't tell whether the agent read the wrong file, used a deprecated API, or just misunderstood the task.

agent-obs is a flight recorder for agent sessions. It's an MCP server plus a local dashboard. Every tool call gets traced — name, duration, status, input, output — along with token usage and estimated cost per session. Each session gets an A–F grade so you can tell at a glance which sessions were clean and which went sideways.

Try it without configuring anything:

  npm install -g agent-obs
  agent-obs demo

That seeds a real agent trace into the local database and opens the dashboard at http://localhost:9400. To trace your actual agent:

  npx agent-obs@latest setup

Setup auto-detects Claude Code, Cursor, or opencode, adds the MCP server to your config, and drops in the self-reporting instruction. Restart your agent and sessions start appearing in the dashboard.

How it works:

1. The agent-obs MCP server exposes a tiny self-reporting protocol: start_session, log_tool_call, end_session. Your agent calls these alongside its normal work, reporting each tool call as it happens.

2. Everything is written to a local SQLite database in ~/.agent-observability/. Nothing leaves your machine. No account, no API key.

3. The dashboard (Express + a single-page frontend) reads the DB and shows sessions, tool calls, token/cost breakdowns, and grades. There's also a REST API (/api/sessions, /api/search, /api/stats) and a CLI — `agent-obs inspect <session-id>` prints a full trace in the terminal.

For agents that can't self-report, there's a proxy mode that wraps any MCP server and intercepts tool calls automatically — but it only sees MCP traffic (~30% of what a typical agent does), so self-reporting is the primary path.

What's different from LangSmith / Langfuse / Helicone:

- Local-first. SQLite on your disk. No cloud dependency, no data exfiltration risk, works on a plane.
- Framework-agnostic. It works with any MCP-capable agent — no SDK to integrate, no code changes to the agent itself. Config plus one instruction.
- The agent grades itself. Because the agent self-reports, it can record what it attempted, not just what succeeded — including failed tool calls that got retried and decision points where it chose one approach over another.

Honest limitations:

- Grading is heuristic — error rates, redundant calls, token efficiency. Useful for triage, not gospel.
- Self-reporting depends on the agent following the instruction. In practice Claude Code and opencode do it reliably, but a very long session occasionally drops a call.
- Cost is an estimate from published API pricing, not your actual invoice.
- Single machine only. No team/fleet view yet (a cloud version is planned, but the open source package will always run standalone).

Why now: MCP went from obscure to the default agent integration protocol in about a year. Agents are being pointed at production repos, customer data, and payment systems — and almost nobody is recording what they do. When an agent does something weird, "check the logs" shouldn't mean scrolling a terminal buffer you closed an hour ago.

GitHub: https://github.com/KryptosAI/agent-observability
npm: agent-obs (MIT, three runtime deps: better-sqlite3, express, uuid)

If you try it, I'd love to hear what breaks — especially on agents and setups I haven't tested. Stars and issues both welcome. Happy to answer anything about the self-reporting protocol or the grading heuristics.
