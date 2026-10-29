'use strict';

// A persona's `tools:` names the project's labels (linear, shell, docker, ...).
// Claude Code, Gemini CLI and Pi read that line as an allowlist of their own
// tool names: Claude refuses to start an agent whose list resolves to nothing,
// Gemini rejects the file, and Pi starts the agent with no tools. The installed
// copies in .claude/, .gemini/ and .pi/agents/ therefore carry native names;
// the source and .agents/agents/ keep the labels. See docs/harness-layout.md.

const { parseFrontmatter } = require('./skill-lint');

const HARNESSES = ['claude', 'gemini', 'pi'];

// Every persona reads; one with a read-only shell does not write files.
const READ = {
  // Claude Code drops Glob and Grep when Bash is listed; without Bash they
  // are a shell-less persona's only way to list and search files.
  claude: ['Read', 'Glob', 'Grep', 'Skill'],
  gemini: ['read_file', 'read_many_files', 'grep_search', 'glob', 'list_directory', 'activate_skill'],
  pi: ['read', 'grep', 'find', 'ls'],
};
const WRITE = {
  claude: ['Edit', 'Write'],
  gemini: ['write_file', 'replace'],
  pi: ['edit', 'write'],
};

// Pi's tracing extension exposes this metadata-only bookkeeping tool. It is a
// harness capability exception, not permission to read or write application
// data or use a shell. Pi ignores the name when the extension is not loaded.
const PI_CONTEXT = 'brain_context';

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
// MCP, through `codemode` limited to the `mcp__` entries; names a setup lacks
// are ignored. `codemode` reaches the permitted MCP tools whatever their
// exposure, so `tool_search` is not needed.
const PI_MCP = ['mcp', 'codemode'];
function server(name) {
  return { claude: [`mcp__${name}`], gemini: [`mcp_${name}_*`], pi: [...PI_MCP, `mcp__${name}__*`] };
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
    pi: [...PI_MCP, ...LINEAR_READ.map(t => `mcp__linear__${t}`)],
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

// Problems with a persona's labels: not an inline list, an unknown label, or
// one reached through a shell the persona does not have.
function labelErrors(tools) {
  if (tools === '') return ['`tools` must be an inline comma-separated list'];
  const labels = splitLabels(tools);
  const errors = [];
  const known = l => Object.hasOwn(LABELS, l);
  const hasShell = labels.some(l => known(l) && (LABELS[l].claude || []).includes('Bash'));
  for (const label of labels) {
    if (!known(label)) errors.push(`unknown tool label "${label}"; add it to scripts/lib/persona-tools.js`);
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
  if (harness === 'pi') out.push(PI_CONTEXT);
  return [...new Set(out)];
}

// The installed copy of a persona for one harness. Frontmatter is not shown
// to the agent, so the labels, and for Gemini the skills, move into the body.
// It reads frontmatter with the validator's parser, so the two agree, and
// writes LF, which pi-herdr-agents' parser requires.
function nativePersona(source, harness) {
  const content = source.replace(/\r\n/g, '\n');
  const match = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*\n/.exec(content);
  if (!match) return content;
  const lines = match[1].split('\n');
  const { tools, skills } = parseFrontmatter(content);
  // No tools line means the native default loadout, not an empty allowlist.
  // Preserve it: adding a context-only list would remove application tools.
  if (tools === undefined) return content;
  // One `key: value` per line: a wrapped value would be read in part and
  // its continuation left behind in the copy.
  const loose = lines.find(l => l.trim() && !/^[A-Za-z0-9_-]+[ \t]*:/.test(l));
  if (loose !== undefined) throw new Error(`frontmatter line "${loose.trim()}" continues a value; write each key on one line`);
  const native = nativeTools(tools, harness);
  // `skills:` goes too: Claude Code and pi-herdr-agents load every listed
  // skill in full at start, Gemini rejects the key, and the persona fetches
  // skills as the activity needs them. Gemini's `tools` is a YAML list.
  const kept = lines.filter(l => !/^(tools|skills)[ \t]*:/.test(l));
  kept.push(harness === 'gemini' ? `tools: [${native.join(', ')}]` : `tools: ${native.join(', ')}`);
  const labels = splitLabels(tools);
  const viaShell = labels.filter(l => LABELS[l].viaShell);
  const note = [`Tools: ${labels.join(', ')}.${viaShell.length ? ` Reach ${viaShell.join(', ')} through the shell.` : ''}`];
  const loader = { claude: ' with the Skill tool', gemini: ' with activate_skill', pi: '' }[harness];
  if (skills) note.push(`Skills (load each as the work needs it${loader}): ${skills}.`);
  let body = content.slice(match[0].length);
  // The first H1 outside a fenced code block.
  let at = 0, fence = null, pos = 0;
  for (const line of body.split('\n')) {
    const f = /^(`{3,}|~{3,})/.exec(line);
    if (f && (!fence || line.startsWith(fence))) fence = fence ? null : f[1];
    else if (!fence && /^# /.test(line)) { at = pos + line.length + 1; break; }
    pos += line.length + 1;
  }
  body = `${body.slice(0, at)}\n${note.join('\n')}\n${body.slice(at)}`;
  return `---\n${kept.join('\n')}\n---\n${body}`;
}

module.exports = { HARNESSES, LABELS, labelErrors, nativeTools, nativePersona };
