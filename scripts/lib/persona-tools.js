'use strict';

// A persona's `tools:` names the project's labels (linear, shell, docker, ...).
// Claude Code, Gemini CLI and Pi read that line as an allowlist of their own
// tool names: Claude refuses to start an agent whose list resolves to nothing,
// Gemini rejects the file, and Pi starts the agent with no tools. The installed
// copies in .claude/, .gemini/ and .pi/agents/ therefore carry native names;
// the source and .agents/agents/ keep the labels. See docs/harness-layout.md.

const HARNESSES = ['claude', 'gemini', 'pi'];

// Every persona reads; one with a read-only label does not write.
const READ = {
  claude: ['Read'],
  gemini: ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory', 'activate_skill'],
  pi: ['read', 'grep', 'find', 'ls'],
};
const WRITE = {
  claude: ['Edit', 'Write'],
  gemini: ['write_file', 'replace'],
  pi: ['edit', 'write'],
};

// Linear's read tools, as its MCP server names them.
const LINEAR_READ = [
  'extract_images', 'get_agent_skill', 'get_attachment', 'get_diff', 'get_diff_threads', 'get_document',
  'get_issue', 'get_issue_status', 'get_milestone', 'get_notifications', 'get_project', 'get_release',
  'get_release_note', 'get_status_updates', 'get_team', 'get_template', 'get_triage_responsibility',
  'get_user', 'get_workspace', 'list_agent_skills', 'list_comments', 'list_custom_views', 'list_cycles',
  'list_diffs', 'list_documents', 'list_issue_labels', 'list_issue_statuses', 'list_issues',
  'list_milestones', 'list_project_labels', 'list_projects', 'list_release_notes',
  'list_release_pipelines', 'list_releases', 'list_teams', 'list_templates', 'list_users',
  'search_documentation',
];

// Pi reaches MCP through pi-mcp-adapter's `mcp` proxy, or, with its built-in
// MCP, through `mcp__<server>__*`; naming both works with either.
function server(name) {
  return { claude: [`mcp__${name}`], gemini: [`mcp_${name}_*`], pi: ['mcp', `mcp__${name}__*`] };
}

const SHELL = { claude: ['Bash'], gemini: ['run_shell_command'], pi: ['bash'] };

// `viaShell` labels have no tool of their own; the agent reaches them with
// their CLI or HTTP API, so they need `shell` beside them.
const LABELS = {
  shell: SHELL,
  'shell (read-only)': { ...SHELL, readOnly: true },
  linear: server('linear'),
  'linear (read)': {
    claude: LINEAR_READ.map(t => `mcp__linear__${t}`),
    gemini: LINEAR_READ.map(t => `mcp_linear_${t}`),
    pi: ['mcp', 'mcp__linear__*'],
    readOnly: true,
  },
  github: server('github'),
  aws: { viaShell: true },
  browser: { viaShell: true },
  docker: { viaShell: true },
  emulator: { viaShell: true },
  grafana: { viaShell: true },
  localstack: { viaShell: true },
  playwright: { viaShell: true },
  postgres: { viaShell: true },
};

const splitLabels = v => String(v || '').split(',').map(s => s.trim()).filter(Boolean);

// Problems with a persona's labels: an unknown label, or one reached through
// a shell the persona does not have.
function labelErrors(tools) {
  const labels = splitLabels(tools);
  const errors = [];
  const hasShell = labels.some(l => LABELS[l] && LABELS[l].claude && LABELS[l].claude.includes('Bash'));
  for (const label of labels) {
    if (!LABELS[label]) errors.push(`unknown tool label "${label}"; add it to scripts/lib/persona-tools.js`);
    else if (LABELS[label].viaShell && !hasShell) errors.push(`tool label "${label}" is reached through the shell, which the persona does not list`);
  }
  return errors;
}

function nativeTools(tools, harness) {
  if (!HARNESSES.includes(harness)) throw new Error(`unknown harness: ${harness}`);
  const labels = splitLabels(tools);
  const errors = labelErrors(tools);
  if (errors.length) throw new Error(errors.join('; '));
  const readOnly = labels.some(l => LABELS[l].readOnly);
  const out = [...READ[harness], ...(readOnly ? [] : WRITE[harness])];
  for (const label of labels) out.push(...(LABELS[label][harness] || []));
  return [...new Set(out)];
}

function frontmatterValue(lines, key) {
  const line = lines.find(l => l.startsWith(`${key}:`));
  return line === undefined ? undefined : line.slice(key.length + 1).trim();
}

// The installed copy of a persona for one harness. Frontmatter is not shown
// to the agent, so the labels, and for Gemini the skills, move into the body.
function nativePersona(content, harness) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(content);
  if (!match) return content;
  const lines = match[1].split(/\r?\n/);
  const tools = frontmatterValue(lines, 'tools');
  const skills = frontmatterValue(lines, 'skills');
  if (tools === undefined) return content;
  const native = nativeTools(tools, harness);
  const kept = lines.filter(l => !l.startsWith('tools:') && !(harness === 'gemini' && l.startsWith('skills:')));
  // Gemini's schema is strict: `tools` is a YAML list and `skills` is unknown.
  kept.push(harness === 'gemini' ? `tools: [${native.join(', ')}]` : `tools: ${native.join(', ')}`);
  const labels = splitLabels(tools);
  const viaShell = labels.filter(l => LABELS[l].viaShell);
  const note = [`Tools: ${labels.join(', ')}.${viaShell.length ? ` Reach ${viaShell.join(', ')} through the shell.` : ''}`];
  if (harness === 'gemini' && skills) note.push(`Skills (load with activate_skill): ${skills}.`);
  let body = content.slice(match[0].length);
  const heading = /^# .*\r?\n/m.exec(body);
  const at = heading ? heading.index + heading[0].length : 0;
  body = `${body.slice(0, at)}\n${note.join('\n')}\n${body.slice(at)}`;
  return `---\n${kept.join('\n')}\n---\n${body}`;
}

module.exports = { HARNESSES, LABELS, labelErrors, nativeTools, nativePersona };
