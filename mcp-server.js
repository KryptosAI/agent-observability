const readline = require('readline');
const database = require('./database');

const SERVER_INFO = {
  name: 'agent-observability',
  version: '0.1.0',
};

const CAPABILITIES = {
  tools: {},
};

const TOOLS = [
  {
    name: 'start_session',
    description: 'Start a new agent observability session to track tool calls, tokens, and errors',
    inputSchema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What task is the agent working on?' },
        agentType: { type: 'string', description: 'Agent type (claude-code, cursor, codex, etc.)' },
        model: { type: 'string', description: 'Model name' },
      },
      required: ['description'],
    },
  },
  {
    name: 'log_tool_call',
    description: 'Log a tool call made by the agent for observability tracking',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        toolName: { type: 'string' },
        toolServer: { type: 'string' },
        input: { type: 'object' },
        output: { type: 'object' },
        outputSummary: { type: 'string' },
        durationMs: { type: 'number' },
        status: { type: 'string', enum: ['success', 'error'] },
        errorMessage: { type: 'string' },
      },
      required: ['sessionId', 'toolName', 'status'],
    },
  },
  {
    name: 'end_session',
    description: 'End an agent observability session and compute the grade',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string' },
        status: { type: 'string', enum: ['complete', 'error', 'failed'] },
        errorMessage: { type: 'string' },
        totalTokens: { type: 'number' },
        inputTokens: { type: 'number' },
        outputTokens: { type: 'number' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'get_last_session',
    description: "Get the most recent session's summary including grade, errors, and cost",
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'check_session',
    description: 'Check the current session status — tool call count, error count, grade estimate, and session duration',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'The session ID to check (optional — uses most recent active session if omitted)' },
      },
    },
  },
  {
    name: 'get_session_stats',
    description: 'Get aggregate stats across all sessions — total sessions, total tool calls, total cost, grade distribution',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
];

function log(message) {
  process.stderr.write(`[agent-obs] ${message}\n`);
}

function sendResponse(id, result) {
  const response = {
    jsonrpc: '2.0',
    id,
    result,
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendError(id, code, message) {
  const response = {
    jsonrpc: '2.0',
    id,
    error: { code, message },
  };
  process.stdout.write(JSON.stringify(response) + '\n');
}

function sendToolResult(id, data) {
  sendResponse(id, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(data),
      },
    ],
  });
}

function handleInitialize(id, params) {
  log('Received initialize request');
  sendResponse(id, {
    protocolVersion: '2024-11-05',
    serverInfo: SERVER_INFO,
    capabilities: CAPABILITIES,
  });
}

function handleToolsList(id) {
  sendResponse(id, { tools: TOOLS });
}

function handleToolsCall(id, params) {
  const { name, arguments: args } = params;

  try {
    switch (name) {
      case 'start_session': {
        const result = database.createSession({
          agentType: args.agentType,
          model: args.model,
          taskDescription: args.description,
        });
        log(`Started session ${result.id}`);
        sendToolResult(id, result);
        break;
      }

      case 'log_tool_call': {
        const result = database.logToolCall({
          sessionId: args.sessionId,
          toolName: args.toolName,
          toolServer: args.toolServer,
          input: args.input,
          output: args.output,
          outputSummary: args.outputSummary,
          durationMs: args.durationMs,
          status: args.status,
          errorMessage: args.errorMessage,
        });

        const existingCalls = database.getToolCalls(args.sessionId);
        database.logDecision({
          sessionId: args.sessionId,
          stepNumber: existingCalls.length,
          chosenAction: args.toolName,
          rationale: args.outputSummary || args.toolName,
        });

        log(`Logged tool call ${result.id} for session ${args.sessionId}`);
        sendToolResult(id, result);
        break;
      }

      case 'end_session': {
        const toolCalls = database.getToolCalls(args.sessionId);
        const errorCount = toolCalls.filter(tc => tc.status === 'error').length;
        const gradeResult = database.computeGrade({
          errorCount,
          totalCalls: toolCalls.length,
          durationMs: 0,
        });

        database.endSession(args.sessionId, {
          status: args.status || 'complete',
          errorMessage: args.errorMessage,
          totalTokens: args.totalTokens,
          inputTokens: args.inputTokens,
          outputTokens: args.outputTokens,
          grade: gradeResult.grade,
        });

        const cost = database.estimateCost(args.totalTokens || 0);

        const summary = {
          sessionId: args.sessionId,
          grade: gradeResult.grade,
          score: gradeResult.score,
          toolCount: toolCalls.length,
          errorCount,
          cost,
        };

        log(`Ended session ${args.sessionId} with grade ${gradeResult.grade}`);
        sendToolResult(id, summary);
        break;
      }

      case 'get_last_session': {
        const sessions = database.getSessions({ limit: 1 });
        if (!sessions || sessions.length === 0) {
          sendToolResult(id, { error: 'No sessions found' });
          break;
        }

        const session = sessions[0];
        const toolCalls = database.getToolCalls(session.id);
        const errorCount = toolCalls.filter(tc => tc.status === 'error').length;

        const summary = {
          sessionId: session.id,
          agentType: session.agent_type,
          model: session.model,
          status: session.status,
          grade: session.grade,
          taskDescription: session.task_description,
          startedAt: session.started_at,
          endedAt: session.ended_at,
          totalTokens: session.total_tokens,
          inputTokens: session.input_tokens,
          outputTokens: session.output_tokens,
          estimatedCostUsd: session.estimated_cost_usd,
          toolCallCount: toolCalls.length,
          toolCount: toolCalls.length,
          errorCount,
          errorMessage: session.error_message,
        };

        sendToolResult(id, summary);
        break;
      }

      case 'check_session': {
        const sessions = database.getSessions({ limit: 1, status: undefined });
        const session = args.sessionId
          ? database.getSession(args.sessionId)
          : (sessions.length > 0 ? sessions[0] : null);

        if (!session) {
          sendToolResult(id, { error: 'No session found. Start one with start_session.' });
          break;
        }

        const toolCalls = database.getToolCalls(session.id);
        const errors = toolCalls.filter(tc => tc.status === 'error').length;
        const grade = database.computeGrade({ errorCount: errors, totalCalls: toolCalls.length, durationMs: 0 });
        const cost = database.estimateCost(session.total_tokens || 0);

        sendToolResult(id, {
          sessionId: session.id,
          status: session.status,
          grade: session.grade || grade.grade,
          score: grade.score,
          toolCalls: toolCalls.length,
          errors,
          totalTokens: session.total_tokens || 0,
          estimatedCostUsd: session.estimated_cost_usd || cost,
          startedAt: session.started_at,
          taskDescription: session.task_description,
        });
        break;
      }

      case 'get_session_stats': {
        const stats = database.getDashboardStats();
        const sessions = database.getSessions({ limit: 1000 });
        const grades = { A: 0, B: 0, C: 0, D: 0, F: 0 };
        sessions.forEach(s => { if (s.grade && grades.hasOwnProperty(s.grade)) grades[s.grade]++; });

        sendToolResult(id, {
          ...stats,
          gradeDistribution: grades,
          latestSession: sessions.length > 0 ? sessions[0].id : null,
        });
        break;
      }

      default:
        sendError(id, -32601, `Unknown tool: ${name}`);
    }
  } catch (err) {
    log(`Error handling tool ${name}: ${err.message}`);
    sendError(id, -32000, err.message);
  }
}

function handlePing(id) {
  sendResponse(id, {});
}

function processMessage(message) {
  try {
    const request = JSON.parse(message);

    if (!request.jsonrpc || request.jsonrpc !== '2.0') {
      log('Invalid JSON-RPC version');
      return;
    }

    const { id, method, params } = request;

    if (method === 'initialize') {
      handleInitialize(id, params);
    } else if (method === 'notifications/initialized') {
      log('Client initialized');
    } else if (method === 'tools/list') {
      handleToolsList(id);
    } else if (method === 'tools/call') {
      handleToolsCall(id, params);
    } else if (method === 'ping') {
      handlePing(id);
    } else {
      log(`Unknown method: ${method}`);
      sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    log(`Failed to parse message: ${err.message}`);
  }
}

function startServer() {
  log('Starting MCP server (stdio)');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', (line) => {
    if (line.trim()) {
      processMessage(line);
    }
  });

  rl.on('close', () => {
    log('stdin closed, shutting down');
    process.exit(0);
  });

  process.stdin.on('end', () => {
    log('stdin ended, shutting down');
    process.exit(0);
  });
}

// Only start when invoked directly or via exported function
// startServer(); — removed auto-start; use startMcpServer() explicitly

module.exports = { startMcpServer: startServer };

if (require.main === module) {
  startServer();
}
