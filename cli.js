#!/usr/bin/env node

const path = require('path');

const { startServer } = require('./server');
const { startProxy, startRecording, recordToolCall, finishRecording } = require('./proxy');
const { startMcpServer } = require('./mcp-server');
const { getSessions, getToolCalls, getDashboardStats } = require('./database');

const pkg = require('./package.json');

const command = process.argv[2];
const args = process.argv.slice(3);

function usage() {
  console.log(`
  agent-obs — Open Source Agent Observability

  Commands:
    server                  Run as MCP server (recommended — agent self-reports all actions)
    dashboard [--port <n>] [--quick]  Start the web dashboard
    setup                   One-command onboarding — detect agent, configure MCP
    demo                    Show a pre-loaded demo session in the dashboard
    check [--last <n>]      Show latest session details
    stats                   Show aggregate session stats
    start <description>     Start a recording session (manual mode)
    stop <session-id>       End a recording session
    log <session-id>        Log a tool call (pipe JSON on stdin)
    proxy [--desc] -- ...   Transparent MCP proxy (fallback — MCP-only capture)
    inspect <session-id>    Show session details in terminal

  Examples:
    agent-obs server
    agent-obs demo
    agent-obs dashboard
    agent-obs check
    agent-obs check --last 3
    agent-obs stats
    agent-obs proxy --desc "fix login bug" -- npx @modelcontextprotocol/server-filesystem /tmp
    agent-obs inspect abc12345

  Without a command, starts the dashboard on port 9400.
  `);
}

function timeAgo(sqliteUtc) {
  if (!sqliteUtc) return 'unknown';
  const then = new Date(sqliteUtc.replace(' ', 'T') + 'Z').getTime();
  if (isNaN(then)) return sqliteUtc;
  const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

function printSummary() {
  console.log(`agent-obs v${pkg.version}`);

  try {
    const stats = getDashboardStats();
    const sessions = getSessions({ limit: 1 });
    const lastGrade = sessions.length ? sessions[0].grade || '?' : '?';

    if (stats.totalSessions === 0) {
      console.log('No sessions yet');
    } else {
      console.log(`${stats.totalSessions} sessions · ${stats.totalToolCalls} tool calls · last grade ${lastGrade}`);
    }
  } catch (_) {
    console.log('No sessions yet');
  }

  console.log('Dashboard: http://localhost:9400');
}

async function main() {
  if (command === 'help' || command === '--help' || command === '-h') {
    printSummary();
    usage();
    process.exit(0);
  }

  if (command === 'dashboard') {
    const portIdx = args.indexOf('--port');
    const quickIdx = args.indexOf('--quick');
    const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 9400;

    if (quickIdx >= 0) {
      const { fork } = require('child_process');
      fork(path.join(__dirname, 'cli.js'), ['server'], { stdio: 'ignore', detached: true }).unref();
      console.log('[agent-obs] MCP server started (agent can now connect)');
    }

    printSummary();
    await startServer(port);
    return;
  }

  if (command === 'server') {
    startMcpServer();
    return;
  }

  if (command === 'check') {
    const lastN = args.indexOf('--last') >= 0 ? parseInt(args[args.indexOf('--last') + 1]) || 1 : 1;
    const sessions = getSessions({ limit: lastN });
    if (!sessions.length) {
      console.log('No agent sessions recorded yet.');
      console.log('Start the dashboard with: agent-obs dashboard');
      process.exit(0);
    }
    if (lastN === 1) {
      const s = sessions[0];
      const calls = getToolCalls(s.id);
      const errors = calls.filter(c => c.status === 'error').length;
      const totalMs = calls.reduce((sum, c) => sum + (c.duration_ms || 0), 0);
      console.log(`Session: ${s.id.slice(0, 8)}`);
      console.log(`Agent:   ${s.agent_type}`);
      console.log(`Task:    ${s.task_description || '(none)'}`);
      console.log(`Status:  ${s.status} | Grade: ${s.grade || 'N/A'}`);
      console.log(`Tools:   ${calls.length} calls | ${errors} ${errors === 1 ? 'error' : 'errors'} | ${(totalMs / 1000).toFixed(1)}s total`);
      console.log(`Tokens:  ${(s.total_tokens || 0).toLocaleString()} | Cost: $${s.estimated_cost_usd}`);
      console.log(`Started: ${timeAgo(s.started_at)}`);
    } else {
      for (const s of sessions) {
        const calls = getToolCalls(s.id);
        const errors = calls.filter(c => c.status === 'error').length;
        const statusIcon = s.status === 'complete' ? '✓' : s.status === 'error' ? '✗' : '⋯';
        console.log(`${statusIcon} ${s.id.slice(0, 8)} | ${s.grade || '?'} | ${(s.task_description || '(none)').slice(0, 50)} | ${calls.length} calls | ${errors} errors | $${s.estimated_cost_usd}`);
      }
    }
    process.exit(0);
  }

  if (command === 'stats') {
    const stats = getDashboardStats();
    console.log('── Agent Observability ──');
    console.log(`Total sessions:    ${stats.totalSessions}`);
    console.log(`Completed:         ${stats.completedSessions}`);
    console.log(`Failed:            ${stats.failedSessions}`);
    console.log(`Total tool calls:  ${stats.totalToolCalls}`);
    console.log(`Total tokens:      ${(stats.totalTokens || 0).toLocaleString()}`);
    console.log(`Total cost:        $${stats.totalCost.toFixed(2)}`);
    console.log(`Avg duration:      ${Math.round(stats.avgDurationSeconds)}s`);

    const gradeValues = { A: 4, B: 3, C: 2, D: 1, F: 0 };
    const distribution = { A: 0, B: 0, C: 0, D: 0, F: 0 };
    const graded = getSessions({ limit: 10000 }).filter(s => s.grade in gradeValues);
    for (const s of graded) distribution[s.grade]++;
    if (graded.length) {
      const avg = graded.reduce((sum, s) => sum + gradeValues[s.grade], 0) / graded.length;
      const avgGrade = ['F', 'D', 'C', 'B', 'A'][Math.round(avg)];
      console.log(`Avg grade:         ${avgGrade}`);
    }
    console.log('');
    console.log('Grade distribution:');
    console.log(`  A: ${distribution.A}  B: ${distribution.B}  C: ${distribution.C}  D: ${distribution.D}  F: ${distribution.F}`);
    process.exit(0);
  }

  if (command === 'setup') {
    const fs = require('fs');
    const path = require('path');
    const cwd = process.cwd();
    let detected = [];
    let actions = [];

    const opencodeJson = path.join(cwd, 'opencode.json');
    if (fs.existsSync(opencodeJson)) {
      detected.push('opencode');
      try {
        const config = JSON.parse(fs.readFileSync(opencodeJson, 'utf8'));
        if (!config.mcp) config.mcp = {};
        if (!config.mcp['agent-obs']) {
          config.mcp['agent-obs'] = {
            type: 'local',
            command: ['npx', '-y', 'agent-obs@latest', 'server'],
            enabled: true
          };
          fs.writeFileSync(opencodeJson, JSON.stringify(config, null, 2) + '\n');
          actions.push('opencode.json updated (agent-obs MCP server added)');
        } else {
          actions.push('opencode.json already has agent-obs ✓');
        }
      } catch (e) {
        actions.push('Could not update opencode.json: ' + e.message);
      }

      const agentsMd = path.join(cwd, 'AGENTS.md');
      const instruction = '\n## Agent Observability (Self-Reporting)\n\nWhen the `agent-obs` MCP server is connected, self-report every tool call:\n\n- Call `agent_obs_start_session` at the start of every task\n- Call `agent_obs_log_tool_call` after EVERY tool call (Read, Write, Edit, Bash, Glob, Grep, etc.) with tool name, duration, status, and output summary\n- Call `agent_obs_end_session` at task completion with token counts\n- NEVER skip log_tool_call — every tool call must be logged. One call = one log.\n- Log errors with status: "error" and the error message\n- Do NOT log the agent-obs tools themselves (start_session, log_tool_call, end_session)\n';

      if (fs.existsSync(agentsMd)) {
        const content = fs.readFileSync(agentsMd, 'utf8');
        if (!content.includes('Agent Observability (Self-Reporting)')) {
          fs.appendFileSync(agentsMd, instruction);
          actions.push('AGENTS.md updated (self-reporting instruction added)');
        } else {
          actions.push('AGENTS.md already has self-reporting instruction ✓');
        }
      } else {
        fs.writeFileSync(agentsMd, instruction + '\n');
        actions.push('AGENTS.md created (self-reporting instruction added)');
      }
    }

    const claudeDir = path.join(cwd, '.claude');
    const mcpJson = path.join(cwd, '.mcp.json');
    if (fs.existsSync(claudeDir) || fs.existsSync(mcpJson)) {
      detected.push('claude-code');
      const target = mcpJson;
      let mcpConfig = {};
      if (fs.existsSync(target)) {
        try { mcpConfig = JSON.parse(fs.readFileSync(target, 'utf8')); } catch(e) {}
      }
      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      if (!mcpConfig.mcpServers['agent-obs']) {
        mcpConfig.mcpServers['agent-obs'] = {
          command: 'npx',
          args: ['-y', 'agent-obs@latest', 'server']
        };
        fs.writeFileSync(target, JSON.stringify(mcpConfig, null, 2) + '\n');
        actions.push('.mcp.json created (agent-obs MCP server configured)');
      } else {
        actions.push('.mcp.json already has agent-obs ✓');
      }
    }

    const cursorDir = path.join(cwd, '.cursor');
    if (fs.existsSync(cursorDir)) {
      detected.push('cursor');
      actions.push('Cursor detected — add this to Cursor Settings > MCP:');
      actions.push('  { "agent-obs": { "command": "npx", "args": ["-y", "agent-obs@latest", "server"] } }');
    }

    if (detected.length === 0) {
      detected.push('unknown');
      actions.push('No AI agent detected in current directory.');
      actions.push('Manual setup:');
      actions.push('  npx agent-obs@latest server    # start MCP server');
      actions.push('  Add agent-obs to your agent MCP config');
    }

    console.log('╔══════════════════════════════════════════╗');
    console.log('║     agent-obs v' + pkg.version + ' — Setup            ║');
    console.log('╚══════════════════════════════════════════╝');
    console.log('');
    console.log('Detected: ' + detected.join(', '));
    actions.forEach(a => console.log('  ✓ ' + a));
    console.log('');
    console.log('Next: restart ' + detected[0]);
    console.log('Dashboard: http://localhost:9400');
    console.log('');
    console.log('To verify:');
    console.log('  agent-obs dashboard');
    console.log('  # Run any task in your agent');
    console.log('  # Sessions should appear automatically');

    // Auto-open dashboard
    const { exec } = require('child_process');
    exec('open http://localhost:9400 2>/dev/null || xdg-open http://localhost:9400 2>/dev/null');

    process.exit(0);
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

  if (command === 'demo') {
    const { seedDemoSession, getSessions } = require('./database');
    seedDemoSession();
    printSummary();
    console.log('Demo session loaded — showing a real agent trace');
    const { exec } = require('child_process');
    exec('open http://localhost:9400');
    await startServer(9400);
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
  printSummary();
  const { exec } = require('child_process');
  const dashboardUrl = 'http://localhost:9400';
  console.log('Opening ' + dashboardUrl + ' ...');
  exec('open ' + dashboardUrl + ' 2>/dev/null || xdg-open ' + dashboardUrl + ' 2>/dev/null');
  await startServer(9400);
}

main().catch(err => {
  console.error('agent-obs error:', err.message);
  process.exit(1);
});
