#!/usr/bin/env node
// Postinstall hook — auto-configures agent-obs after npm install -g
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = os.homedir();
const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

console.log('\n  agent-obs@' + pkg.version + ' installed');
console.log('  Auto-configuring...\n');

const mcpConfig = {
  type: 'local',
  command: ['npx', '-y', 'agent-obs@latest', 'server'],
  enabled: true
};

const instruction = `
## Agent Observability (Self-Reporting)

When the \`agent-obs\` MCP server is connected, self-report every tool call:

- Call \`agent_obs_start_session\` at the start of every task
- Call \`agent_obs_log_tool_call\` after EVERY tool call (Read, Write, Edit, Bash, Glob, Grep, etc.) with tool name, duration, status, and output summary
- Call \`agent_obs_end_session\` at task completion with token counts
- NEVER skip log_tool_call — every tool call must be logged. One call = one log.
- Log errors with status: "error" and the error message
- Do NOT log the agent-obs tools themselves (start_session, log_tool_call, end_session)
`;

let configured = 0;

// 1. Global opencode config
const opencodePaths = [
  path.join(home, '.config', 'opencode', 'opencode.json'),
  path.join(home, '.opencode', 'opencode.json'),
];
for (const p of opencodePaths) {
  if (fs.existsSync(p)) {
    try {
      const config = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!config.mcp) config.mcp = {};
      if (!config.mcp['agent-obs']) {
        config.mcp['agent-obs'] = mcpConfig;
        fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
        console.log('  ✓ opencode.json configured:', p);
        configured++;
      } else {
        console.log('  ✓ opencode.json already configured:', p);
      }
    } catch (e) {
      console.log('  - Could not update', p);
    }
  }
}

// 2. Global Claude config
const claudePaths = [
  path.join(home, '.claude.json'),
  path.join(home, '.config', 'claude', 'claude_desktop_config.json'),
  path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
];
for (const p of claudePaths) {
  if (fs.existsSync(p)) {
    try {
      const config = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!config.mcpServers) config.mcpServers = {};
      if (!config.mcpServers['agent-obs']) {
        config.mcpServers['agent-obs'] = {
          command: 'npx',
          args: ['-y', 'agent-obs@latest', 'server']
        };
        fs.writeFileSync(p, JSON.stringify(config, null, 2) + '\n');
        console.log('  ✓ Claude config configured:', p);
        configured++;
      } else {
        console.log('  ✓ Claude config already configured:', p);
      }
    } catch (e) {
      console.log('  - Could not update', p);
    }
  }
}

// 3. If nothing configured, create a starter .mcp.json in home
if (configured === 0) {
  const starterPath = path.join(home, '.mcp.json');
  if (!fs.existsSync(starterPath)) {
    const starter = { mcpServers: { 'agent-obs': { command: 'npx', args: ['-y', 'agent-obs@latest', 'server'] } } };
    fs.writeFileSync(starterPath, JSON.stringify(starter, null, 2) + '\n');
    console.log('  ✓ Created starter .mcp.json in home directory');
    console.log('    Point your agent at this file to enable agent-obs.');
    configured++;
  } else {
    console.log('  ✓ .mcp.json already exists in home directory');
  }
}

// 4. Print next steps
console.log('');
if (configured > 0) {
  console.log('  agent-obs is configured. Restart your agent to activate.');
} else {
  console.log('  agent-obs installed. To use:');
  console.log('    npx agent-obs@latest setup    (in your project)');
  console.log('    npx agent-obs@latest demo     (see a live example)');
}
console.log('');
console.log('  Dashboard: http://localhost:9400');
console.log('  Setup:     npx agent-obs@latest setup');
console.log('  Demo:      npx agent-obs@latest demo');
console.log('');

process.exit(0);
