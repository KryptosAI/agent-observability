const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(require('os').homedir(), '.agent-observability', 'sessions.db');
const fs = require('fs');

let db;

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function getDb() {
  if (!db) {
    ensureDir();
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema();
  }
  return db;
}

function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      agent_type TEXT NOT NULL DEFAULT 'unknown',
      model TEXT,
      status TEXT DEFAULT 'running',
      grade TEXT,
      total_tokens INTEGER DEFAULT 0,
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      estimated_cost_usd REAL DEFAULT 0,
      started_at TEXT DEFAULT (datetime('now')),
      ended_at TEXT,
      error_message TEXT,
      task_description TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      tool_server TEXT,
      step_number INTEGER DEFAULT 0,
      input_json TEXT,
      output_json TEXT,
      output_summary TEXT,
      duration_ms INTEGER DEFAULT 0,
      status TEXT DEFAULT 'success',
      error_message TEXT,
      input_schema_valid INTEGER DEFAULT 1,
      output_schema_valid INTEGER DEFAULT 1,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS skill_loads (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      skill_name TEXT NOT NULL,
      skill_version TEXT,
      loaded_at TEXT DEFAULT (datetime('now')),
      token_cost INTEGER DEFAULT 0,
      was_useful INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS decision_points (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      step_number INTEGER DEFAULT 0,
      chosen_action TEXT,
      rationale TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS audit_entries (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      actor TEXT DEFAULT 'agent',
      resource_accessed TEXT,
      permission_scope TEXT,
      outcome TEXT,
      response_time_ms INTEGER DEFAULT 0,
      source_ip TEXT,
      timestamp TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS tool_health_checks (
      id TEXT PRIMARY KEY,
      tool_server TEXT NOT NULL,
      health_score INTEGER DEFAULT 0,
      grade TEXT,
      tool_count INTEGER DEFAULT 0,
      gate TEXT DEFAULT 'unknown',
      checks_json TEXT,
      checked_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_type);
    CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions(started_at);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_session ON tool_calls(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_calls_tool ON tool_calls(tool_name);
    CREATE INDEX IF NOT EXISTS idx_skill_loads_session ON skill_loads(session_id);
    CREATE INDEX IF NOT EXISTS idx_decision_points_session ON decision_points(session_id);
    CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_entries(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_health_server ON tool_health_checks(tool_server);
  `);

  seedDemoSession();
}

// ── Sessions ──

function createSession({ agentType, model, taskDescription }) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO sessions (id, agent_type, model, task_description) VALUES (?, ?, ?, ?)`)
    .run(id, agentType || 'unknown', model || null, taskDescription || null);
  return { id, agentType, model };
}

function endSession(id, { status, errorMessage, totalTokens, inputTokens, outputTokens, grade }) {
  const db = getDb();
  const cost = totalTokens ? estimateCost(totalTokens) : 0;
  db.prepare(`UPDATE sessions SET status = ?, ended_at = datetime('now'), error_message = ?,
    total_tokens = ?, input_tokens = ?, output_tokens = ?, estimated_cost_usd = ?, grade = ?
    WHERE id = ?`)
    .run(status || 'complete', errorMessage || null, totalTokens || 0, inputTokens || 0,
      outputTokens || 0, cost, grade || null, id);
}

function getSession(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

function getSessions({ limit = 50, agentType, status } = {}) {
  let query = 'SELECT * FROM sessions WHERE 1=1';
  const params = [];
  if (agentType) { query += ' AND agent_type = ?'; params.push(agentType); }
  if (status) { query += ' AND status = ?'; params.push(status); }
  query += ' ORDER BY started_at DESC LIMIT ?';
  params.push(limit);
  return getDb().prepare(query).all(...params);
}

// ── Tool Calls ──

function logToolCall({ sessionId, toolName, toolServer, stepNumber, input, output, outputSummary, durationMs, status, errorMessage, inputSchemaValid, outputSchemaValid }) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO tool_calls (id, session_id, tool_name, tool_server, step_number,
    input_json, output_json, output_summary, duration_ms, status, error_message,
    input_schema_valid, output_schema_valid)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, sessionId, toolName, toolServer || null, stepNumber || 0,
      JSON.stringify(input || {}), JSON.stringify(output || {}),
      (outputSummary || '').slice(0, 500), durationMs || 0, status || 'success',
      errorMessage || null, inputSchemaValid ? 1 : 0, outputSchemaValid ? 1 : 0);
  return { id };
}

function getToolCalls(sessionId) {
  return getDb().prepare('SELECT * FROM tool_calls WHERE session_id = ? ORDER BY step_number ASC, timestamp ASC').all(sessionId);
}

// ── Skill Loads ──

function logSkillLoad({ sessionId, skillName, skillVersion, tokenCost }) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO skill_loads (id, session_id, skill_name, skill_version, token_cost)
    VALUES (?, ?, ?, ?, ?)`)
    .run(id, sessionId, skillName, skillVersion || null, tokenCost || 0);
  return { id };
}

function markSkillUseful(id, useful) {
  getDb().prepare('UPDATE skill_loads SET was_useful = ? WHERE id = ?').run(useful ? 1 : 0, id);
}

// ── Decision Points ──

function logDecision({ sessionId, stepNumber, chosenAction, rationale }) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO decision_points (id, session_id, step_number, chosen_action, rationale)
    VALUES (?, ?, ?, ?, ?)`)
    .run(id, sessionId, stepNumber || 0, chosenAction || '', (rationale || '').slice(0, 500));
  return { id };
}

function getDecisions(sessionId) {
  return getDb().prepare('SELECT * FROM decision_points WHERE session_id = ? ORDER BY step_number ASC').all(sessionId);
}

// ── Audit Entries ──

function logAudit({ sessionId, eventType, actor, resourceAccessed, permissionScope, outcome, responseTimeMs, sourceIp }) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO audit_entries (id, session_id, event_type, actor, resource_accessed,
    permission_scope, outcome, response_time_ms, source_ip)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(id, sessionId, eventType, actor || 'agent', resourceAccessed || null,
      permissionScope || null, outcome || null, responseTimeMs || 0, sourceIp || null);
  return { id };
}

function getAuditEntries(sessionId) {
  return getDb().prepare('SELECT * FROM audit_entries WHERE session_id = ? ORDER BY timestamp ASC').all(sessionId);
}

// ── Tool Health Checks (from MCP Observatory) ──

function recordHealthCheck({ toolServer, healthScore, grade, toolCount, gate, checks }) {
  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO tool_health_checks (id, tool_server, health_score, grade, tool_count, gate, checks_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(id, toolServer, healthScore, grade || 'F', toolCount || 0, gate || 'unknown', JSON.stringify(checks || []));
  return { id };
}

function getLatestHealthChecks() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM tool_health_checks t1
    WHERE t1.checked_at = (
      SELECT MAX(t2.checked_at) FROM tool_health_checks t2 WHERE t2.tool_server = t1.tool_server
    )
    ORDER BY t1.tool_server ASC
  `).all();
}

function getHealthHistory(toolServer, limit = 20) {
  return getDb().prepare(
    'SELECT * FROM tool_health_checks WHERE tool_server = ? ORDER BY checked_at DESC LIMIT ?'
  ).all(toolServer, limit);
}

// ── Dashboard Stats ──

function getDashboardStats() {
  const db = getDb();
  const totalSessions = db.prepare('SELECT COUNT(*) as c FROM sessions').get().c;
  const completedSessions = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE status = 'complete'").get().c;
  const failedSessions = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE status IN ('error', 'failed')").get().c;
  const totalToolCalls = db.prepare('SELECT COUNT(*) as c FROM tool_calls').get().c;
  const avgDuration = db.prepare(
    "SELECT AVG((julianday(ended_at) - julianday(started_at)) * 86400) as avg FROM sessions WHERE ended_at IS NOT NULL"
  ).get().avg || 0;
  const totalCost = db.prepare('SELECT SUM(estimated_cost_usd) as c FROM sessions').get().c || 0;
  const totalTokens = db.prepare('SELECT SUM(total_tokens) as c FROM sessions').get().c || 0;

  return {
    totalSessions, completedSessions, failedSessions, totalToolCalls,
    avgDurationSeconds: Math.round(avgDuration), totalCost: Math.round(totalCost * 100) / 100,
    totalTokens,
  };
}

// ── Helpers ──

function estimateCost(totalTokens) {
  // Rough estimate: $3 per 1M tokens (Claude Sonnet pricing)
  return Math.round((totalTokens / 1000000) * 3 * 10000) / 10000;
}

function computeGrade({ errorCount, totalCalls, durationMs }) {
  if (totalCalls === 0) return { grade: 'N/A', score: 0 };
  const errorRate = errorCount / totalCalls;
  if (errorRate === 0) return { grade: 'A', score: 95 };
  if (errorRate < 0.1) return { grade: 'B', score: 80 };
  if (errorRate < 0.25) return { grade: 'C', score: 60 };
  if (errorRate < 0.5) return { grade: 'D', score: 40 };
  return { grade: 'F', score: 20 };
}

function closeStaleSessions() {
  const db = getDb();
  const stale = db.prepare(`
    SELECT id FROM sessions 
    WHERE status = 'running' 
    AND started_at < datetime('now', '-1 hour')
    AND ended_at IS NULL
  `).all();
  
  for (const s of stale) {
    const calls = getToolCalls(s.id);
    const errors = calls.filter(c => c.status === 'error').length;
    const grade = computeGrade({ errorCount: errors, totalCalls: calls.length, durationMs: 0 });
    endSession(s.id, { 
      status: 'timeout', 
      errorMessage: 'Auto-closed: no activity for over 1 hour',
      grade: grade.grade
    });
  }
  return stale.length;
}

function seedDemoSession() {
  const db = getDb();
  const existing = db.prepare('SELECT COUNT(*) as cnt FROM sessions').get();
  if (existing.cnt > 0) return false;

  const sessionId = 'demo-session-001';
  const now = new Date().toISOString();
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();

  db.prepare(`INSERT INTO sessions (id, agent_type, model, status, grade, total_tokens, input_tokens, output_tokens, estimated_cost_usd, task_description, error_message, started_at, ended_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(sessionId, 'claude-code', 'claude-sonnet-4-20250514', 'complete', 'B', 12450, 9800, 2650, 0.0374,
      'Fix login redirect bug in auth middleware — session expired after 15min instead of 24h',
      null, fiveMinAgo, now);

  const tools = [
    { name: 'Read', server: 'filesystem', step: 1, status: 'success', duration: 34, input: '{"filePath":"/src/auth.ts"}', output: '{"content":"function login() { ... }"}', summary: 'Read 210 lines of auth middleware' },
    { name: 'Grep', server: 'search', step: 2, status: 'success', duration: 89, input: '{"pattern":"session.*expir"}', output: '{"matches":["line 42: session.expiry = 15 * 60"]}', summary: 'Found session expiry: 15 min at line 42' },
    { name: 'Read', server: 'filesystem', step: 3, status: 'success', duration: 12, input: '{"filePath":"/src/config.ts"}', output: '{"content":"export const SESSION_TTL = 86400"}', summary: 'Read config: SESSION_TTL = 86400 (24h)' },
    { name: 'Bash', server: 'terminal', step: 4, status: 'success', duration: 1240, input: '{"command":"npm test -- --run auth"}', output: '{"stdout":"8 passed, 1 failed"}', summary: '1 test failing: session expires too early' },
    { name: 'Edit', server: 'filesystem', step: 5, status: 'success', duration: 27, input: '{"filePath":"/src/auth.ts","oldString":"session.expiry = 15 * 60","newString":"session.expiry = SESSION_TTL"}', output: '{"applied":true}', summary: 'Replaced hardcoded 15min with SESSION_TTL constant' },
    { name: 'Read', server: 'filesystem', step: 6, status: 'error', duration: 8, input: '{"filePath":"/src/missing.ts"}', output: '{}', summary: '', error: 'ENOENT: no such file, path not found' },
    { name: 'Bash', server: 'terminal', step: 7, status: 'success', duration: 890, input: '{"command":"npm test -- --run auth"}', output: '{"stdout":"9 passed, 0 failed"}', summary: 'All 9 tests pass — redirect now uses 24h TTL' },
    { name: 'Glob', server: 'search', step: 8, status: 'success', duration: 56, input: '{"pattern":"**/auth*"}', output: '{"files":["auth.ts","auth.test.ts"]}', summary: 'Found auth.ts and auth.test.ts' },
    { name: 'Write', server: 'filesystem', step: 9, status: 'success', duration: 18, input: '{"filePath":"/CHANGELOG.md","content":"..."}', output: '{"bytesWritten":412}', summary: 'Updated CHANGELOG with redirect fix' },
    { name: 'Grep', server: 'search', step: 10, status: 'success', duration: 45, input: '{"pattern":"TODO|FIXME"}', output: '{"matches":[]}', summary: 'No TODOs or FIXMEs remaining' },
    { name: 'Bash', server: 'terminal', step: 11, status: 'success', duration: 67, input: '{"command":"git diff --stat"}', output: '{"stdout":"2 files changed, 3 insertions, 3 deletions"}', summary: '2 files changed: auth.ts, config.ts' },
    { name: 'Edit', server: 'filesystem', step: 12, status: 'success', duration: 22, input: '{"filePath":"/src/auth.ts","oldString":"console.log(expiry)","newString":""}', output: '{"applied":true}', summary: 'Removed debug console.log from auth.ts' },
  ];

  const insertCall = db.prepare(`INSERT INTO tool_calls (id, session_id, tool_name, tool_server, step_number, input_json, output_json, output_summary, duration_ms, status, error_message, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const insertDecision = db.prepare(`INSERT INTO decision_points (id, session_id, step_number, chosen_action, rationale, timestamp) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertAudit = db.prepare(`INSERT INTO audit_entries (id, session_id, event_type, actor, resource_accessed, outcome, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)`);

  const tx = db.transaction(() => {
    for (const t of tools) {
      const id = 'demo-call-' + t.step;
      const ts = new Date(Date.now() - (12 - t.step) * 25000).toISOString();
      insertCall.run(id, sessionId, t.name, t.server, t.step, t.input, t.output, t.summary, t.duration, t.status, t.error || null, ts);
      insertDecision.run('demo-decision-' + t.step, sessionId, t.step, 'tool:' + t.name, 'Called ' + t.name + ' (' + t.duration + 'ms, ' + t.status + ')', ts);
    }
    insertAudit.run('demo-audit-1', sessionId, 'session_start', 'agent', '/src/auth.ts', 'started', fiveMinAgo);
    insertAudit.run('demo-audit-2', sessionId, 'session_end', 'agent', '/src/auth.ts', 'complete', now);
  });

  tx();
  return true;
}

module.exports = {
  getDb, initSchema,
  createSession, endSession, getSession, getSessions,
  logToolCall, getToolCalls,
  logSkillLoad, markSkillUseful,
  logDecision, getDecisions,
  logAudit, getAuditEntries,
  recordHealthCheck, getLatestHealthChecks, getHealthHistory,
  getDashboardStats, computeGrade, estimateCost, closeStaleSessions,
  seedDemoSession,
};
