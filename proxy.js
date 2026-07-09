const { spawn } = require('child_process');
const readline = require('readline');
const {
  createSession, endSession, logToolCall, logDecision, logAudit,
  computeGrade, estimateCost,
} = require('./database');

function startProxy(targetCommand, targetArgs, options = {}) {
  const { taskDescription, agentType } = options;

  const session = createSession({
    agentType: agentType || 'opencode',
    taskDescription: taskDescription || 'MCP proxy session',
  });

  console.error(`\n[agent-obs] Session ${session.id.slice(0, 8)} started`);
  console.error(`[agent-obs] Proxying: ${targetCommand} ${(targetArgs || []).join(' ')}`);
  console.error(`[agent-obs] Task: ${taskDescription || '(no description)'}\n`);

  const child = spawn(targetCommand, targetArgs || [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
    shell: true,
  });

  let toolCount = 0;
  let errorCount = 0;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let stepNumber = 0;
  const knownTools = new Map();
  let agentStdinBuffer = '';
  let buffering = false;

  logAudit({
    sessionId: session.id,
    eventType: 'session_start',
    actor: 'agent-obs',
    resourceAccessed: targetCommand,
    outcome: 'started',
  });

  // Parse inbound JSON-RPC messages from the agent (via stdin to the proxy)
  const agentRl = readline.createInterface({ input: process.stdin });
  agentRl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      handleAgentMessage(msg);
    } catch (_) {
      process.stdout.write(line + '\n');
    }
  });

  // Parse outbound JSON-RPC from the MCP server (child stdout)
  const serverRl = readline.createInterface({ input: child.stdout });
  serverRl.on('line', (line) => {
    try {
      const msg = JSON.parse(line);
      handleServerMessage(msg);
    } catch (_) {
      process.stdout.write(line + '\n');
    }
  });

  // Pass stderr through
  child.stderr.pipe(process.stderr);

  function handleAgentMessage(msg) {
    const isCall = msg.method === 'tools/call';
    const isList = msg.method === 'tools/list';

    if (isCall) {
      stepNumber++;
      const toolName = msg.params?.name || 'unknown';
      const toolArgs = msg.params?.arguments || {};

      console.error(`[agent-obs] Step ${stepNumber}: Calling tool "${toolName}"`);

      // Store the call start time
      msg._obs_callStart = Date.now();
      msg._obs_stepNumber = stepNumber;
      msg._obs_toolName = toolName;
      msg._obs_input = toolArgs;
    }

    if (isList) {
      console.error('[agent-obs] Tool discovery requested');
    }

    // Forward to MCP server
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  function handleServerMessage(msg) {
    const isError = msg.error !== undefined;
    const isResult = msg.result !== undefined;
    const hasTools = msg.result?.tools !== undefined;

    // Detect tools/list response
    if (isResult && hasTools) {
      const tools = msg.result.tools || [];
      tools.forEach(t => knownTools.set(t.name, t));
      console.error(`[agent-obs] Server advertised ${tools.length} tools`);
    }

    // Detect tools/call response
    if (isResult && !hasTools && !('capabilities' in (msg.result || {}))) {
      toolCount++;
      const callStart = msg._obs_callStart || Date.now();
      const durationMs = Date.now() - callStart;
      const toolName = msg._obs_toolName || 'unknown';
      const input = msg._obs_input || {};
      const isErrorResult = msg.result?.isError === true;

      // Extract token usage from result metadata if available
      const metaTokens = msg.result?.meta?.tokens || msg.result?._meta?.tokens || {};
      const inputTokens = metaTokens.input || metaTokens.prompt || 0;
      const outputTokens = metaTokens.output || metaTokens.completion || 0;
      totalInputTokens += inputTokens;
      totalOutputTokens += outputTokens;

      if (isErrorResult) errorCount++;

      // Generate output summary
      const outputContent = msg.result?.content || [];
      let outputSummary = '';
      if (Array.isArray(outputContent)) {
        outputSummary = outputContent.map(c => {
          if (c.type === 'text') return (c.text || '').slice(0, 100);
          if (c.type === 'image') return '[image]';
          if (c.type === 'resource') return '[resource]';
          return JSON.stringify(c).slice(0, 100);
        }).join(' | ');
      } else if (typeof msg.result === 'object') {
        outputSummary = JSON.stringify(msg.result).slice(0, 200);
      }

      logToolCall({
        sessionId: session.id,
        toolName,
        toolServer: targetCommand,
        stepNumber: msg._obs_stepNumber || stepNumber,
        input: typeof input === 'object' ? input : { value: input },
        output: msg.result || {},
        outputSummary: outputSummary.slice(0, 500),
        durationMs,
        status: isErrorResult ? 'error' : 'success',
        errorMessage: isErrorResult ? (msg.result?.content?.[0]?.text || 'Tool returned error') : null,
        inputSchemaValid: 1,
        outputSchemaValid: isErrorResult ? 0 : 1,
      });

      logDecision({
        sessionId: session.id,
        stepNumber: msg._obs_stepNumber || stepNumber,
        chosenAction: `tool:${toolName}`,
        rationale: `Called ${toolName} (${durationMs}ms, ${isErrorResult ? 'returned error' : 'success'})`,
      });

      const statusIcon = isErrorResult ? '✗' : '✓';
      console.error(`[agent-obs] ${statusIcon} ${toolName} (${durationMs}ms)${isErrorResult ? ' ERROR' : ''}`);
    }

    if (isError) {
      errorCount++;
      logAudit({
        sessionId: session.id,
        eventType: 'mcp_error',
        actor: 'mcp_server',
        outcome: `error: ${(msg.error?.message || 'unknown').slice(0, 200)}`,
      });
    }

    // Forward to agent
    process.stdout.write(JSON.stringify(msg) + '\n');
  }

  child.on('error', (err) => {
    console.error(`[agent-obs] Proxy error: ${err.message}`);
    endSession(session.id, {
      status: 'error',
      errorMessage: err.message,
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      grade: computeGrade({ errorCount, totalCalls: toolCount, durationMs: 0 }).grade,
    });
    process.exit(1);
  });

  child.on('close', (code) => {
    const sessionData = getDbSession(session.id);
    const grade = computeGrade({
      errorCount,
      totalCalls: toolCount,
      durationMs: 0,
    });

    endSession(session.id, {
      status: code === 0 ? 'complete' : 'error',
      errorMessage: code !== 0 ? `MCP server exited with code ${code}` : null,
      totalTokens: totalInputTokens + totalOutputTokens,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      grade: grade.grade,
    });

    logAudit({
      sessionId: session.id,
      eventType: 'session_end',
      actor: 'agent-obs',
      outcome: code === 0 ? 'complete' : `exited_${code}`,
    });

    console.error(`\n[agent-obs] Session ${session.id.slice(0, 8)} ended`);
    console.error(`[agent-obs] Tools called: ${toolCount} | Errors: ${errorCount}`);
    console.error(`[agent-obs] Tokens: ${totalInputTokens + totalOutputTokens} | Est. cost: $${estimateCost(totalInputTokens + totalOutputTokens)}`);
    console.error(`[agent-obs] Grade: ${grade.grade} | Status: ${code === 0 ? 'complete' : 'error'}\n`);

    process.exit(code || 0);
  });

  // Handle signals
  process.on('SIGINT', () => {
    child.kill('SIGINT');
  });
  process.on('SIGTERM', () => {
    child.kill('SIGTERM');
  });
}

function getDbSession(sessionId) {
  const { getSession } = require('./database');
  return getSession(sessionId);
}

// Direct recording mode — record a session manually without proxying
function startRecording({ taskDescription, agentType, model }) {
  const { createSession } = require('./database');
  return createSession({ agentType: agentType || 'manual', model, taskDescription });
}

function recordToolCall(sessionId, { toolName, toolServer, input, output, outputSummary, durationMs, status, errorMessage }) {
  const { logToolCall, getToolCalls } = require('./database');
  const calls = getToolCalls(sessionId);
  return logToolCall({
    sessionId, toolName, toolServer,
    stepNumber: calls.length + 1,
    input, output, outputSummary, durationMs, status, errorMessage,
  });
}

function finishRecording(sessionId, { status, errorMessage, totalTokens }) {
  const { getDb } = require('./database');
  const db = getDb();
  const calls = db.prepare('SELECT * FROM tool_calls WHERE session_id = ?').all(sessionId);
  const errors = calls.filter(c => c.status === 'error').length;
  const grade = computeGrade({ errorCount: errors, totalCalls: calls.length, durationMs: 0 });

  const { endSession } = require('./database');
  endSession(sessionId, { status, errorMessage, totalTokens, grade: grade.grade });
  return { sessionId, grade: grade.grade, toolCount: calls.length, errorCount: errors };
}

module.exports = { startProxy, startRecording, recordToolCall, finishRecording };
