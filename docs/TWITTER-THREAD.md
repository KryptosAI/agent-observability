# Twitter/X Thread — agent-obs launch

7 tweets. Post in order. Each is under 280 characters.

---

**Tweet 1 (hook)**

Your AI agent just spent 11 minutes "fixing the login bug."

What did it actually do? Which files did it read? How many approaches did it try? What did it cost?

You have no idea. Nobody does.

I built a flight recorder for agent sessions. Open source, local-first 🧵

**Tweet 2 (problem)**

Coding agents are black boxes. You get a diff and a vibe.

• A "quick" session can burn $5 in tokens
• Failed sessions leave no trace of why
• Can't tune prompts you can't measure
• An agent reading your secrets file? You'd never know

The fix isn't more willpower. It's traces.

**Tweet 3 (what it does)**

agent-obs traces every tool call your agent makes:

✓ name, duration, status, input, output
✓ tokens + estimated cost per session
✓ A–F grade per session
✓ full audit trail with search

All in a local dashboard at localhost:9400. SQLite on your disk. Nothing leaves your machine.

**Tweet 4 (quick start)**

Try it in 30 seconds:

npm install -g agent-obs
agent-obs demo

→ opens a live dashboard with a real agent trace

Then `npx agent-obs@latest setup` auto-configures Claude Code, Cursor, or opencode. Restart your agent and every session gets recorded.

**Tweet 5 (how it works)**

It's an MCP server with a tiny self-reporting protocol:

start_session → log_tool_call (×N) → end_session

The agent reports its own actions → local SQLite → dashboard + REST API + CLI.

No SDK. No cloud account. No agent code changes. Works with any MCP-capable agent.

**Tweet 6 (honest caveats)**

Being upfront about the rough edges:

• grades are heuristics — good for triage, not gospel
• self-reporting depends on the agent following instructions (reliable in practice, not perfect)
• cost is an estimate, not your invoice
• single-machine only; fleet view comes later

**Tweet 7 (CTA)**

MCP is the default agent protocol now. Agents are touching prod repos, customer data, and payment systems — and nobody's watching what they do.

Star it, try the demo, tell me what breaks:

https://github.com/KryptosAI/agent-observability
