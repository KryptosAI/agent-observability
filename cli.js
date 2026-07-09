#!/usr/bin/env node

const { startServer } = require('./server');
const { startProxy, startRecording, recordToolCall, finishRecording } = require('./proxy');
const { startMcpServer } = require('./mcp-server');

const command = process.argv[2];
const args = process.argv.slice(3);

function usage() {
  console.log(`
  agent-obs — Open Source Agent Observability

  Commands:
    start <description>     Start a recording session (manual mode)
    stop <session-id>       End a recording session
    log <session-id>        Log a tool call (pipe JSON on stdin)
    proxy [--desc <text>] [--agent <type>] -- <command...>
                            Transparent MCP proxy — intercepts all tool calls
    server                  Run as MCP server (agents self-report via MCP tools)
    dashboard [--port <n>]  Start the web dashboard
    inspect <session-id>    Show session details in terminal

  Examples:
    agent-obs proxy --desc "fix login bug" -- npx @modelcontextprotocol/server-filesystem /tmp
    agent-obs server
    agent-obs dashboard
    agent-obs inspect abc12345

  Without a command, starts the dashboard on port 9400.
  `);
}

async function main() {
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    process.exit(0);
  }

  if (command === 'dashboard') {
    const portIdx = args.indexOf('--port');
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 9400;
    await startServer(port);
    return;
  }

  if (command === 'server') {
    startMcpServer();
    return;
  }

  if (command === 'proxy') {
    const separatorIdx = args.indexOf('--');
    if (separatorIdx < 0) {
      console.error('Usage: agent-obs proxy [--desc <text>] -- <command...>');
      process.exit(1);
    }

    let taskDesc = 'MCP proxy session';
    let agentType = 'opencode';
    const proxyArgs = args.slice(0, separatorIdx);

    for (let i = 0; i < proxyArgs.length; i++) {
      if (proxyArgs[i] === '--desc' && proxyArgs[i + 1]) {
        taskDesc = proxyArgs[i + 1];
        i++;
      } else if (proxyArgs[i] === '--agent' && proxyArgs[i + 1]) {
        agentType = proxyArgs[i + 1];
        i++;
      }
    }

    const cmdArgs = args.slice(separatorIdx + 1);
    if (cmdArgs.length === 0) {
      console.error('No command specified after --');
      process.exit(1);
    }

    const targetCommand = cmdArgs.join(' ');
    startProxy(targetCommand, [], { taskDescription: taskDesc, agentType });
    return;
  }

  if (command === 'start') {
    const desc = args.join(' ') || 'Manual session';
    const session = startRecording({ taskDescription: desc });
    console.log(JSON.stringify(session));
    process.exit(0);
  }

  if (command === 'stop') {
    const sessionId = args[0];
    if (!sessionId) {
      console.error('Usage: agent-obs stop <session-id>');
      process.exit(1);
    }
    const result = finishRecording(sessionId, { status: 'complete' });
    console.log(JSON.stringify(result));
    process.exit(0);
  }

  if (command === 'log') {
    const sessionId = args[0];
    if (!sessionId) {
      console.error('Usage: agent-obs log <session-id>');
      process.exit(1);
    }

    const chunks = [];
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => chunks.push(chunk));
    process.stdin.on('end', () => {
      try {
        const data = JSON.parse(chunks.join(''));
        const result = recordToolCall(sessionId, data);
        console.log(JSON.stringify(result));
        process.exit(0);
      } catch (e) {
        console.error('Invalid JSON input:', e.message);
        process.exit(1);
      }
    });
    // If stdin already ended (no pipe), exit
    if (process.stdin.isTTY) {
      console.error('Usage: echo \'{"toolName":"..."}\' | agent-obs log <session-id>');
      process.exit(1);
    }
    return;
  }

  if (command === 'inspect') {
    const sessionId = args[0];
    if (!sessionId) {
      console.error('Usage: agent-obs inspect <session-id>');
      process.exit(1);
    }

    const { getSession, getToolCalls, getDecisions } = require('./database');
    const session = getSession(sessionId);
    if (!session) {
      console.error('Session not found');
      process.exit(1);
    }

    const calls = getToolCalls(session.id);
    const decisions = getDecisions(session.id);

    console.log(`\n  Session: ${session.id}`);
    console.log(`  Agent:   ${session.agent_type}`);
    console.log(`  Task:    ${session.task_description || '(none)'}`);
    console.log(`  Status:  ${session.status} | Grade: ${session.grade || 'N/A'}`);
    console.log(`  Tokens:  ${session.total_tokens} | Cost: $${session.estimated_cost_usd}`);
    console.log(`  Started: ${session.started_at}`);
    if (session.ended_at) console.log(`  Ended:   ${session.ended_at}`);
    if (session.error_message) console.log(`  Error:   ${session.error_message}`);

    console.log(`\n  Tool Calls (${calls.length}):`);
    for (const call of calls) {
      const status = call.status === 'error' ? '✗' : '✓';
      console.log(`    ${status} Step ${call.step_number}: ${call.tool_name} (${call.duration_ms}ms)`);
      if (call.output_summary) {
        console.log(`      → ${call.output_summary.slice(0, 120)}`);
      }
      if (call.error_message) {
        console.log(`      ✗ ${call.error_message}`);
      }
    }

    console.log('');
    process.exit(0);
  }

  // Default: start dashboard
  await startServer(9400);
}

main().catch(err => {
  console.error('agent-obs error:', err.message);
  process.exit(1);
});
