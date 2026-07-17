---
name: agent-obs-opencode
description: Self-report every agent action to the agent-obs observability MCP server. Use in EVERY session where the agent-obs MCP server is connected - start a session at task start, log every tool call (Read, Write, Edit, Bash, Glob, Grep, etc.), end the session at task completion, and answer "how did my last session go" questions with get_last_session.
license: MIT
metadata:
  server: agent-obs
  dashboard: http://localhost:9400
---

# agent-obs Self-Reporting

You are an observed agent. The `agent-obs` MCP server is a local flight recorder
for everything you do: tool calls, errors, tokens, cost, and a final A-F grade.
It only works if you report into it. This skill defines the reporting protocol.
Follow it in every task, in every session, without being asked.

## The Protocol (four tools, three phases)

### Phase 1 — Start: call `start_session` FIRST

- At the very beginning of every task — before Read, before Bash, before
  anything else — call the `start_session` tool on the `agent-obs` server.
- Pass:
  - `description` (required): one sentence describing the task, e.g.
    `"Fix login redirect bug in auth middleware"`.
  - `agentType`: your client, e.g. `"opencode"`, `"claude-code"`, `"cursor"`, `"codex"`.
  - `model`: your model id, e.g. `"deepseek/deepseek-v4-pro"`.
- The result contains a session `id`. **Save it.** Every subsequent
  `log_tool_call` and the final `end_session` needs this exact `sessionId`.
- One task = one session. If the user pivots to a brand-new task in the same
  conversation, end the current session and start a new one.

Example:

```json
start_session({
  "description": "Refactor payment webhook handler and add tests",
  "agentType": "opencode",
  "model": "deepseek/deepseek-v4-pro"
})
→ { "id": "a1b2c3d4" }   // keep this sessionId
```

### Phase 2 — Log: call `log_tool_call` after EVERY tool call

- Immediately after each tool call completes (Read, Write, Edit, Bash, Glob,
  Grep, Task, WebFetch, TodoWrite, any MCP tool — ALL of them), call
  `log_tool_call` with:
  - `sessionId` (required): the id from `start_session`.
  - `toolName` (required): the tool you just used, e.g. `"Read"`, `"Bash"`, `"Edit"`.
  - `status` (required): `"success"` if the tool call worked, `"error"` if it
    failed, errored, or was rejected.
  - `toolServer`: where the tool lives, e.g. `"builtin"`, `"playwright"`, `"cloudflare-bindings"`.
  - `input`: a compact object of the arguments, e.g. `{ "filePath": "src/auth.ts" }`.
    Redact secrets — never log tokens, keys, or passwords.
  - `outputSummary`: one line describing what happened, e.g.
    `"Read 120 lines of auth middleware"` or `"npm test: 42 passed"`.
  - `durationMs`: approximate wall-clock duration if known.
  - `errorMessage`: the error text when `status` is `"error"`.
- **NEVER skip `log_tool_call` — even for fast operations. Every tool call must
  be logged.** A one-line Glob counts. A 2ms Read counts. If you called a tool,
  you log it. No batching several calls into one log entry, no "it was trivial"
  exceptions.
- Log failures too. An errored Bash command logged with `status: "error"` is
  exactly the signal the grading system needs.
- The only calls you do NOT log are the `agent-obs` tools themselves
  (`start_session`, `log_tool_call`, `end_session`, `get_last_session`).
  Logging the logger would recurse forever.

Example (after reading a file):

```json
log_tool_call({
  "sessionId": "a1b2c3d4",
  "toolName": "Read",
  "toolServer": "builtin",
  "status": "success",
  "input": { "filePath": "src/webhooks/payment.ts" },
  "outputSummary": "Read 210 lines of payment webhook handler",
  "durationMs": 40
})
```

Example (after a failed command):

```json
log_tool_call({
  "sessionId": "a1b2c3d4",
  "toolName": "Bash",
  "toolServer": "builtin",
  "status": "error",
  "input": { "command": "npx vitest run src/webhooks --maxWorkers=2" },
  "outputSummary": "2 tests failed in payment.spec.ts",
  "errorMessage": "AssertionError: expected 402 to be 200"
})
```

### Phase 3 — End: call `end_session` when the task is done

- When the task is complete (or you must stop), call `end_session` with:
  - `sessionId` (required).
  - `status`: `"complete"` if the task succeeded, `"error"` if it ended due to
    an unrecoverable error, `"failed"` if you could not accomplish the task.
  - `errorMessage`: why, when status is not `"complete"`.
  - `totalTokens`, `inputTokens`, `outputTokens`: your best estimate of token
    usage for the session, if available.
- `end_session` computes and returns the session grade. Report the grade to the
  user in your final summary when it is relevant (e.g. "Session graded A, 14
  tool calls, 0 errors").
- Never leave a session open. If the user interrupts, cancels, or the task dies,
  end the session with the appropriate status before finishing your turn.

Example:

```json
end_session({
  "sessionId": "a1b2c3d4",
  "status": "complete",
  "totalTokens": 48200,
  "inputTokens": 41000,
  "outputTokens": 7200
})
→ { "grade": "A", "score": 100, "toolCount": 14, "errorCount": 0, "cost": 0.19 }
```

### Anytime — `get_last_session` for performance questions

- When the user asks anything like "how did the last run go?", "what did that
  cost?", "what's my grade?", "how many tool calls did you make?", or "why did
  the last session fail?" — call `get_last_session` and answer from its data
  (grade, status, token totals, estimated cost, tool count, error count,
  timestamps, error message).
- Prefer real recorded data over recalling from memory. The database is the
  source of truth.

## Rules (non-negotiable)

- ALWAYS call `start_session` before your first working tool call of a task.
- **NEVER skip `log_tool_call` — even for fast operations. Every tool call must
  be logged.**
- One `log_tool_call` per tool call, immediately after it returns. Do not defer
  or batch logging to the end of the task.
- Log errors with `status: "error"` and an `errorMessage`. Honest telemetry is
  the point; a session full of hidden failures that grades "A" is worthless.
- ALWAYS call `end_session` before declaring the task finished.
- Do not log the agent-obs tools themselves.
- Redact secrets, API keys, tokens, and passwords from `input`/`output` fields.
- If the agent-obs server is unavailable (tool calls to it error out), tell the
  user once, continue the actual task normally, and do not retry-loop the
  logger. Observability must never block the work it observes.

## What gets tracked

Everything you report feeds the local dashboard at **http://localhost:9400**
(start it with `agent-obs dashboard`). Data lives in a SQLite database at
`~/.agent-observability/` — nothing leaves the machine.

| Signal | Source | Shown in dashboard as |
|--------|--------|-----------------------|
| Sessions | `start_session` / `end_session` | Session list with task description, agent type, model, timestamps |
| Tool calls | `log_tool_call` | Per-session timeline: tool name, server, duration, status, input, output summary |
| Errors | `log_tool_call` with `status: "error"` | Error count, per-call error messages, failure patterns |
| Tokens | `end_session` token fields | Input/output/total tokens per session |
| Cost | Computed from tokens | Estimated USD per session and aggregate |
| Decisions | Auto-derived from each logged call | Step-by-step audit trail of what you chose to do |
| Grade | Computed at `end_session` | A-F badge per session, average grade in `/api/stats` |

The dashboard supports filtering by grade, full-text search across tool call
inputs/outputs, per-session drill-down, and JSON export.

## Grades

Every ended session receives a letter grade:

- **A = Clean** — zero errors, efficient tool usage, task completed.
- **B = Minor issues** — some inefficiencies (duplicate reads, dead-end calls), but no failures.
- **C = Inefficient** — redundant tool calls, excessive tokens, or recoverable errors.
- **D = Risky** — multiple failed calls, high cost, or demonstrably wrong tool choices.
- **F = Failed** — errors prevented task completion, or the session was abandoned.

Your logging determines your grade. Unlogged calls make sessions look
artificially clean and defeat the entire system.

## MCP server config

Add the `agent-obs` server to your agent client. Requires
`npm install -g agent-obs` (or point `command` at a local checkout).

For **opencode** (`opencode.json` or `~/.config/opencode/opencode.json`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "agent-obs": {
      "type": "local",
      "command": ["agent-obs", "server"],
      "enabled": true
    }
  }
}
```

For **Claude Code / Cursor / any `.mcp.json` client**:

```json
{
  "mcpServers": {
    "agent-obs": {
      "command": "agent-obs",
      "args": ["server"]
    }
  }
}
```

Running from a local checkout instead of the global install:

```json
{
  "mcp": {
    "agent-obs": {
      "type": "local",
      "command": ["node", "/path/to/agent-observability/cli.js", "server"],
      "enabled": true
    }
  }
}
```

After editing config, restart the agent client so the MCP server loads. Verify
by checking that `start_session`, `log_tool_call`, `end_session`, and
`get_last_session` appear in your available tools (they may be prefixed, e.g.
`agent-obs_start_session`).

## Why this matters

Without self-reporting, an agent session is a black box: a diff appears and
nobody knows how many tool calls it took, what failed along the way, which
files were touched, or what it cost. agent-obs turns each session into an
auditable flight record — but only the agent can see its own actions, so only
the agent can report them.

- **Cost visibility.** Token and cost tracking per session shows whether a task
  burned $0.05 or $5.00.
- **Failure forensics.** When output is wrong, the logged timeline shows exactly
  which call failed, with what error, and what happened next.
- **Prompt and workflow tuning.** Redundant reads, wrong-tool choices, and
  retry loops show up as C/D grades — concrete data for improving instructions.
- **Audit trail.** Every file read, command run, and network fetch is
  timestamped and searchable, so access to sensitive data is reviewable.

A skipped `log_tool_call` is a blind spot in all four. That is why the rule is
absolute: **NEVER skip `log_tool_call` — even for fast operations. Every tool
call must be logged.**
