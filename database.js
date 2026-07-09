const Database = require('better-sqlite3');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DB_PATH = path.join(__dirname, '.agent-observability', 'sessions.db');
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

module.exports = {
  getDb, initSchema,
  createSession, endSession, getSession, getSessions,
  logToolCall, getToolCalls,
  logSkillLoad, markSkillUseful,
  logDecision, getDecisions,
  logAudit, getAuditEntries,
  recordHealthCheck, getLatestHealthChecks, getHealthHistory,
  getDashboardStats, computeGrade, estimateCost,
};
