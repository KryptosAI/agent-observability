const express = require('express');
const path = require('path');
const {
  getSessions, getSession, getToolCalls,
  getDecisions, getAuditEntries,
  getDashboardStats, getLatestHealthChecks, getHealthHistory,
  recordHealthCheck, computeGrade,
} = require('./database');

const app = express();
const PORT = process.env.PORT || 9400;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Health ────────────────────────────────────────
app.get('/api/health', (_req, res) => {
  const stats = getDashboardStats();
  res.json({ status: 'ok', ...stats, timestamp: new Date().toISOString() });
});

// ─── Sessions ──────────────────────────────────────
app.get('/api/sessions', (req, res) => {
  const limit = parseInt(req.query.limit) || 50;
  const sessions = getSessions({ limit, agentType: req.query.agentType, status: req.query.status });
  res.json(sessions.map(s => ({
    id: s.id,
    agentType: s.agent_type,
    model: s.model,
    status: s.status,
    grade: s.grade,
    totalTokens: s.total_tokens,
    estimatedCost: s.estimated_cost_usd,
    taskDescription: s.task_description,
    errorMessage: s.error_message,
    startedAt: s.started_at,
    endedAt: s.ended_at,
  })));
});

app.get('/api/sessions/:id', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'Session not found' });

  const toolCalls = getToolCalls(session.id).map(c => ({
    id: c.id,
    toolName: c.tool_name,
    toolServer: c.tool_server,
    stepNumber: c.step_number,
    input: safeParse(c.input_json),
    output: safeParse(c.output_json),
    outputSummary: c.output_summary,
    durationMs: c.duration_ms,
    status: c.status,
    errorMessage: c.error_message,
    timestamp: c.timestamp,
  }));

  const decisions = getDecisions(session.id);
  const auditEntries = getAuditEntries(session.id);

  res.json({
    ...session,
    agentType: session.agent_type,
    taskDescription: session.task_description,
    errorMessage: session.error_message,
    estimatedCost: session.estimated_cost_usd,
    totalTokens: session.total_tokens,
    startedAt: session.started_at,
    endedAt: session.ended_at,
    inputTokens: session.input_tokens,
    outputTokens: session.output_tokens,
    toolCalls,
    decisions,
    auditEntries,
    toolCallCount: toolCalls.length,
    errorCount: toolCalls.filter(c => c.status === 'error').length,
  });
});

// ─── Tool Health ───────────────────────────────────
app.get('/api/tool-health', (_req, res) => {
  const checks = getLatestHealthChecks();
  res.json(checks.map(c => ({
    id: c.id,
    toolServer: c.tool_server,
    healthScore: c.health_score,
    grade: c.grade,
    toolCount: c.tool_count,
    gate: c.gate,
    checkedAt: c.checked_at,
  })));
});

app.get('/api/tool-health/:server/history', (req, res) => {
  const history = getHealthHistory(req.params.server, 30);
  res.json(history.map(c => ({
    healthScore: c.health_score,
    grade: c.grade,
    gate: c.gate,
    toolCount: c.tool_count,
    checkedAt: c.checked_at,
  })));
});

app.post('/api/tool-health', (req, res) => {
  const { toolServer, healthScore, grade, toolCount, gate, checks } = req.body;
  if (!toolServer) return res.status(400).json({ error: 'toolServer required' });
  const result = recordHealthCheck({ toolServer, healthScore, grade, toolCount, gate, checks });
  res.status(201).json(result);
});

// ─── Stats ─────────────────────────────────────────
app.get('/api/stats', (_req, res) => {
  const stats = getDashboardStats();
  res.json(stats);
});

// ─── Fallback ──────────────────────────────────────
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function safeParse(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch (_) { return str; }
}

function startServer(port) {
  const p = port || PORT;
  return new Promise((resolve) => {
    app.listen(p, () => {
      console.log(`\n  Agent Observability Dashboard`);
      console.log(`  http://localhost:${p}\n`);
      resolve(app);
    });
  });
}

module.exports = { app, startServer };
