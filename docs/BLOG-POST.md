---
title: "We built agent observability because agents are black boxes"
published: false
description: "Every tool call, every error, every dollar. How we made AI agent sessions traceable, gradable, and auditable — for free, locally, open source."
tags: ai, opensource, mcp, devtools
cover_image: 
---

## The Problem

Here's a scene that plays out thousands of times a day now.

You hand your AI agent a task: "fix the login redirect bug." It runs for five minutes. Terminal output scrolls by too fast to read. Then it stops, and you have a diff.

The diff looks plausible. But answer these questions:

- Was that 5 tool calls or 50?
- Which files did it actually read before deciding what to change?
- Did it try three approaches and backtrack twice, or nail it on the first pass?
- Did anything fail silently along the way?
- What did those five minutes cost you?

You can't answer any of them. Neither can we, and we build this stuff. The agent is a black box: task in, diff out, everything in the middle gone.

This stopped being an academic annoyance for us and became a real operational problem, for three reasons.

### 1. Cost blindness

Agents burn tokens invisibly. A session that *feels* quick can torch $5 in API calls because the agent decided to read your entire `node_modules`-adjacent directory tree for context. A session that feels slow might have cost $0.40 because it was waiting on a test suite. Your intuition about cost is completely decoupled from reality, and nobody sends you an itemized receipt. You're flying blind on spend — per task, per day, per repo.

### 2. Failure forensics

When the output is wrong, you currently have nothing to work with. The agent produced a broken migration — why? Did it read the wrong schema file? Call a deprecated API? Grep for the wrong symbol and confidently run with a bad assumption? Without a trace, "debugging the agent" means re-running it with a more emphatic prompt and hoping. That's not debugging. That's prayer.

### 3. Trust erosion

This is the one that compounds. Teams are putting agents into CI, into code review, into production-adjacent workflows. But every time an agent does something weird and you can't explain it, your trust budget drains a little. Eventually you end up in the worst possible state: you're *deploying* agents (because they're productive) while *not trusting* them (because you can't see them). That gap is where bad things live — the agent that read a file full of secrets it didn't need, the agent that made a network call nobody expected, the agent that deleted the wrong fixture and nobody noticed for a week.

We wanted a flight recorder. So we built one.

## The Solution: agent-obs

**agent-obs** is an open-source observability layer for AI coding agents. It makes every agent session traceable, gradable, and auditable.

Not just "logged." Anybody can append lines to a log file. We mean:

- **Traceable** — every tool call recorded with its inputs, outputs, duration, and status, linked to a session.
- **Gradable** — every session gets an A–F grade, so "how is my agent doing?" has an answer you can chart.
- **Auditable** — a local, queryable record of what was read, edited, and executed. Full-text searchable.

And the constraints we cared about: it runs **locally** (SQLite on your machine, nothing leaves it), it's **agent-agnostic** (works with opencode, Claude Code, Cursor, or anything that speaks MCP), and it's **free and MIT-licensed forever**.

## How It Works

The architecture is deliberately boring. Boring is good for infrastructure you want to trust.

```
┌─────────────────┐   self-reports via MCP   ┌──────────────────┐
│  Your agent     │ ───────────────────────▶ │  agent-obs       │
│  (opencode,     │  start_session           │  MCP server      │
│   Claude Code,  │  log_tool_call × N       │                  │
│   Cursor, ...)  │  end_session             │                  │
└─────────────────┘                          └────────┬─────────┘
                                                      │ writes
                                                      ▼
                                            ┌──────────────────┐
                                            │  Local SQLite    │
                                            │  ~/.agent-       │
                                            │  observability/  │
                                            └────────┬─────────┘
                                                     │ reads
                                                     ▼
                                            ┌──────────────────┐
                                            │  Dashboard       │
                                            │  localhost:9400  │
                                            └──────────────────┘
```

The key design decision: **the agent self-reports**. agent-obs runs as an MCP server with six tools (`start_session`, `log_tool_call`, `end_session`, `check_session`, `get_last_session`, `get_session_stats`). You add one instruction to your agent's config — "after every tool call, report it" — and the agent narrates its own execution as it works. Because the agent reports each call explicitly, coverage is ~100% of actions, not just the subset that happens to flow through an MCP proxy.

(There *is* a proxy mode — `agent-obs proxy -- <some-mcp-server>` — that transparently intercepts MCP traffic for agents that can't self-report. But it only sees MCP tool calls, roughly 30% of what a typical agent does. It's a fallback, not the main path.)

Setup is one command:

```bash
npx agent-obs@latest setup
```

It auto-detects your agent (opencode, Claude Code, Cursor), adds agent-obs to your MCP config, drops in the self-reporting instruction, and tells you to restart your agent. No YAML, no API keys, no account creation. Then:

```bash
agent-obs dashboard    # http://localhost:9400
```

The dashboard is a local Express app with three views: a **sessions list** (every session with grade, cost, duration, and tool call count), a **session trace** (the full timeline of one session — more on this below), and **tool health** (which tools are erroring, which are slow). There's also a REST API under `/api/` if you want to query your own data, and a full-text search endpoint because "did any agent ever read `secrets.env`?" is a question you should be able to answer in one keystroke.

## The Demo

Here's what you actually see. Say you asked your agent to fix a login redirect bug. You open the dashboard, click the session, and get the trace:

```
Session: "fix login redirect bug"                    Grade: B
Duration: 4m 51s     Tool calls: 12     Tokens: ~11.2k     Cost: $0.04

 #  Tool        Status    Duration   Summary
 1  glob        success     210 ms   src/**/*.ts → 47 files
 2  read        success     180 ms   src/auth/login.ts (214 lines)
 3  read        success     165 ms   src/auth/session.ts (98 lines)
 4  grep        success     240 ms   "redirect" in src/ → 9 matches
 5  read        success     175 ms   src/routes.ts (156 lines)
 6  read        success     160 ms   src/auth/login.ts (214 lines)   ← duplicate
 7  edit        success     320 ms   src/auth/login.ts — redirect guard
 8  bash        success   38,400 ms  npx vitest run auth.test.ts — 6/7 pass
 9  read        success     190 ms   test/auth.test.ts (132 lines)
10  edit        success     280 ms   src/auth/login.ts — edge case fix
11  bash        success   37,900 ms  npx vitest run auth.test.ts — 7/7 pass
12  end_session success       8 ms   grade computed: B
```

Every row expands to show full tool input and output. Now the anatomy of what you're looking at:

**The timeline** answers "what did it do" in five seconds. You can see it globbed, read three files, grepped, edited, tested, iterated once, tested again. That matches your mental model of a competent fix. If instead you saw 40 reads across unrelated directories before the edit, you'd know the diff deserves a harder review.

**Row 6 is why this session got a B.** The agent re-read `src/auth/login.ts` — a file it had already read, unchanged, four calls earlier. Redundant context fetch, wasted tokens, zero failures. That's the definition of a B: *minor issues, no failures*. An A means zero errors and no waste. A C means real inefficiency or recoverable errors. D means risky — failed calls, wrong tools, cost out of proportion. F means the task didn't complete.

**$0.04 is why cost tracking matters.** Cost is computed from token counts against published per-model pricing (and you can override pricing in `~/.agent-observability/models.json` if you're on a negotiated rate or a model we don't know). Four cents is nothing. But when a "quick refactor" session shows up at $6.80 because the agent decided to read your entire monorepo, you find out *that day* — not on the monthly invoice.

**The grade is the point.** One session trace is useful. But grades accumulate. The stats view shows your grade distribution and average over time, per machine. That's when observability stops being postmortem and starts being feedback: you change a system prompt, and a week later you can see whether your B-average moved or didn't.

We should be honest about the limits. Self-reporting depends on the agent following the instruction — agents are mostly reliable at this, but "mostly" isn't "always," and a missed call is invisible by definition. The grade heuristics are exactly that: heuristics. They'll misjudge a session occasionally. And cost is an estimate, not a billing statement. We'd rather tell you that than have you find out.

## What's Built

Shipped in v1.0, today:

- **MCP server with 6 tools** — `start_session`, `log_tool_call`, `end_session`, `check_session`, `get_last_session`, `get_session_stats`. Any MCP-capable agent can plug in.
- **Dashboard** (localhost:9400) — sessions list, session trace timeline, tool health, stats, full-text search across tool call inputs/outputs.
- **CLI** — `agent-obs setup`, `dashboard`, `check`, `stats`, `inspect <id>`, `demo`, plus `proxy` mode for passive MCP capture.
- **Self-reporting protocol** — a three-phase pattern (start → log × N → end) any agent can adopt, not just the ones we auto-configure.
- **Local SQLite storage** — everything in `~/.agent-observability/`. No cloud, no account, no telemetry you didn't opt into.
- **A–F session grades** — computed at `end_session` from errors, redundancy, and efficiency.
- **Machine fingerprints** — a SHA256 of platform, arch, Node version, and home directory, so sessions persist across restarts with zero PII. In CI, `GITHUB_REPOSITORY` is mixed in, so the same repo gets a stable identity even in ephemeral containers.

## Open Source

agent-obs is MIT licensed and local-first. That is not a launch-week posture; it's the architecture. There is no agent-obs cloud account because there is no cloud. Your traces are arguably the most sensitive telemetry your development process produces — they contain what your agent read, which is to say what your codebase contains. They belong on your disk.

A cloud tier (team dashboards, alerting when an agent's grade slides, historical trends) may come later, following the Sentry model: the local product never degrades, the cloud adds collaboration. The core stays free.

- **GitHub:** [KryptosAI/agent-observability](https://github.com/KryptosAI/agent-observability)
- **npm:** [`agent-obs`](https://www.npmjs.com/package/agent-obs)

## Call to Action

We're at about 420 npm downloads a week. That's enough to know people want this, and nowhere near enough to know where it breaks.

So:

```bash
npx agent-obs@latest setup
```

Run one real task with it. Open the dashboard. Look at the grade and ask whether it's fair — if it isn't, that's a bug report we want. If the setup mis-detects your agent, that's a bug report we want. If your agent ignores the self-reporting instruction half the time, *especially* that's a bug report we want.

Star the repo if it's useful. File an issue if it isn't. We'd rather have 50 developers telling us what's wrong than 5,000 silent downloads.

Black boxes are fine for airplanes, because airplanes have flight recorders. Now your agents do too.
