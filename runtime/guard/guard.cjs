'use strict';

// Branch guard (FAC-47). It refuses a shell command, before it runs, that would delete a local branch
// (`git branch -d/-D/--delete`, `git update-ref -d`), remove or prune a worktree (`git worktree remove|prune`),
// or merge a pull request and delete its branch (`gh pr merge -d/--delete-branch`). Those belong to
// `merge-pr.js`, which deletes nothing until GitHub reports the merge, and `agent-env.js teardown`, which removes only
// what spawn created. Both run git as child processes, which no harness hook sees, so they need no exception.
//
// The decision is deterministic: a shell parse of the command text, with no model and no repository reads.
// A value the shell only knows when the command runs ($VAR, $(...), `...`, $'...', a leading glob, a brace
// expansion) matches anything, so the guard fails closed. Text the guard cannot parse is refused when it mentions
// one of these commands. What it cannot see: a command inside a script file or program the agent runs, and a
// git or gh alias defined in config; those are a known limit, not a contract.

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'su', 'runuser']);
const GIT_VALUE_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--attr-source', '--list-cmds']);
const MAX_DEPTH = 8;

const SCRIPTS = 'Branches and worktrees are removed only by the git-workflow-and-versioning skill\'s scripts/merge-pr.js '
  + '(after GitHub reports the pull request merged) and the development-setup skill\'s scripts/agent-env.js teardown '
  + '(only what spawn created). Run those instead. If the owner wants it done by hand, they run it in their own terminal.';
const reason = what => `Blocked by the branch guard (FAC-47): ${what}. ${SCRIPTS}`;
const UNKNOWN_NOTE = ' A value in a variable, substitution, glob or brace is unknown until the command runs, so the guard treats it as a delete flag: write it literally.';

class ParseError extends Error {}

// A small POSIX-shell reader: it splits the text into simple commands (word lists) and parses every command
// substitution, backtick and process substitution as commands of its own. Each word is { text, unknown, quoted }.
class Parser {
  constructor(src, out) { this.src = src; this.i = 0; this.out = out; this.heredocs = []; }

  // Commands up to `stop` (')' or '`') or the end of the text.
  list(stop) {
    const { src } = this;
    let words = [];
    let redirect = false;
    let depth = 0;
    const end = () => {
      if (redirect) throw new ParseError('redirection without a target');
      if (words.length) this.out.push(words);
      words = [];
    };
    for (;;) {
      if (this.i >= src.length) {
        if (stop) throw new ParseError(`missing ${stop}`);
        end();
        return;
      }
      const c = src[this.i];
      if (stop === '`' && c === '`') { this.i++; end(); return; }
      if (c === ' ' || c === '\t' || c === '\r') { this.i++; continue; }
      if (c === '\\' && src[this.i + 1] === '\n') { this.i += 2; continue; }
      if (c === '\n') { this.i++; end(); this.readHeredocs(); continue; }
      if (c === '#') { while (this.i < src.length && src[this.i] !== '\n') this.i++; continue; }
      if (c === '&' && src[this.i + 1] === '>') { this.i += src[this.i + 2] === '>' ? 3 : 2; redirect = true; continue; }
      if (c === '(' ) { this.i++; depth++; end(); continue; }
      if (c === ')') {
        this.i++;
        if (stop === ')' && depth === 0) { end(); return; }
        if (depth > 0) depth--;
        end();
        continue;
      }
      if (c === ';' || c === '&' || c === '|') {
        this.i++;
        if ((c === '&' || c === '|') && src[this.i] === c) this.i++;
        else if (c === '|' && src[this.i] === '&') this.i++;
        else if (c === ';' && src[this.i] === ';') { this.i++; if (src[this.i] === '&') this.i++; }
        else if (c === ';' && src[this.i] === '&') this.i++;
        end();
        continue;
      }
      if (c === '<' || c === '>') {
        if (src[this.i + 1] === '(') { this.i += 2; this.list(')'); continue; }
        if (src.startsWith('<<<', this.i)) { this.i += 3; redirect = true; continue; }
        if (src.startsWith('<<', this.i)) {
          this.i += 2;
          const strip = src[this.i] === '-';
          if (strip) this.i++;
          while (src[this.i] === ' ' || src[this.i] === '\t') this.i++;
          const delim = this.word(stop);
          if (delim.text === '' && !delim.quoted) throw new ParseError('here-document without a delimiter');
          this.heredocs.push({ delim: delim.text, quoted: delim.quoted, strip });
          continue;
        }
        this.i++;
        if ('>&|'.includes(src[this.i]) || (c === '<' && src[this.i] === '>')) this.i++;
        redirect = true;
        continue;
      }
      const w = this.word(stop);
      if (redirect) { redirect = false; continue; }
      if (!w.quoted && /^\d+$/.test(w.text) && (src[this.i] === '<' || src[this.i] === '>')) continue;
      words.push(w);
    }
  }

  word(stop) {
    const { src } = this;
    const w = { text: '', unknown: false, quoted: false };
    let brace = false;
    for (;;) {
      if (this.i >= src.length) break;
      const c = src[this.i];
      if (' \t\r\n;&|()<>'.includes(c)) break;
      if (c === '`') {
        if (stop === '`') break;
        this.i++;
        this.list('`');
        w.unknown = true;
        continue;
      }
      if (c === '\\') {
        if (src[this.i + 1] === '\n') { this.i += 2; continue; }
        if (this.i + 1 < src.length) w.text += src[this.i + 1];
        this.i += 2;
        w.quoted = true;
        continue;
      }
      if (c === '\'') {
        const j = src.indexOf('\'', this.i + 1);
        if (j < 0) throw new ParseError('unterminated single quote');
        w.text += src.slice(this.i + 1, j);
        this.i = j + 1;
        w.quoted = true;
        continue;
      }
      if (c === '"') { this.i++; this.dquote(w, '"'); w.quoted = true; continue; }
      if (c === '$') {
        if (src[this.i + 1] === '"') { this.i += 2; this.dquote(w, '"'); w.quoted = true; continue; }
        if (this.dollar()) { w.unknown = true; continue; }
        w.text += '$';
        this.i++;
        continue;
      }
      if (!w.quoted && w.text === '' && '*?['.includes(c)) w.unknown = true;
      if (c === '{') brace = true;
      w.text += c;
      this.i++;
    }
    if (brace && w.text.length > 1 && /,|\.\./.test(w.text)) w.unknown = true;
    return w;
  }

  // Inside double quotes (or a here-document body when `end` is null): escapes, $... and backticks.
  dquote(w, end) {
    const { src } = this;
    for (;;) {
      if (this.i >= src.length) {
        if (end) throw new ParseError('unterminated double quote');
        return;
      }
      const c = src[this.i];
      if (end && c === end) { this.i++; return; }
      if (c === '\\') {
        const n = src[this.i + 1];
        if (n === '\n') { this.i += 2; continue; }
        if (n !== undefined && '$`"\\'.includes(n)) { w.text += n; this.i += 2; continue; }
        w.text += '\\';
        this.i++;
        continue;
      }
      if (c === '$') {
        if (this.dollar()) { w.unknown = true; continue; }
        w.text += '$';
        this.i++;
        continue;
      }
      if (c === '`') { this.i++; this.list('`'); w.unknown = true; continue; }
      w.text += c;
      this.i++;
    }
  }

  // At a `$`: consume an expansion and return true, or return false for a literal `$`.
  dollar() {
    const { src } = this;
    const n = src[this.i + 1];
    if (n === '(') {
      if (src[this.i + 2] === '(') {
        let depth = 0;
        let j = this.i + 1;
        for (; j < src.length; j++) {
          if (src[j] === '(') depth++;
          else if (src[j] === ')' && --depth === 0) break;
        }
        if (j >= src.length) throw new ParseError('unterminated arithmetic expansion');
        new Parser(src.slice(this.i + 3, j - 1), this.out).dquote({ text: '', unknown: false }, null);
        this.i = j + 1;
        return true;
      }
      this.i += 2;
      this.list(')');
      return true;
    }
    if (n === '{') {
      let depth = 0;
      let j = this.i + 1;
      for (; j < src.length; j++) {
        if (src[j] === '{') depth++;
        else if (src[j] === '}' && --depth === 0) break;
      }
      if (j >= src.length) throw new ParseError('unterminated parameter expansion');
      new Parser(src.slice(this.i + 2, j), this.out).dquote({ text: '', unknown: false }, null);
      this.i = j + 1;
      return true;
    }
    if (n === '\'') {
      let j = this.i + 2;
      for (; j < src.length && src[j] !== '\''; j++) if (src[j] === '\\') j++;
      if (j >= src.length) throw new ParseError('unterminated $\'...\'');
      this.i = j + 1;
      return true;
    }
    if (n !== undefined && /[A-Za-z_]/.test(n)) {
      this.i += 2;
      while (this.i < src.length && /[A-Za-z0-9_]/.test(src[this.i])) this.i++;
      return true;
    }
    if (n !== undefined && /[0-9@*#?$!-]/.test(n)) { this.i += 2; return true; }
    return false;
  }

  readHeredocs() {
    const { src } = this;
    for (const h of this.heredocs.splice(0)) {
      let body = '';
      while (this.i < src.length) {
        let j = src.indexOf('\n', this.i);
        if (j < 0) j = src.length;
        const line = src.slice(this.i, j);
        this.i = Math.min(j + 1, src.length);
        if ((h.strip ? line.replace(/^\t+/, '') : line) === h.delim) break;
        body += `${line}\n`;
      }
      // An unquoted delimiter leaves $(...) and `...` in the body live.
      if (!h.quoted) new Parser(body, this.out).dquote({ text: '', unknown: false }, null);
    }
  }
}

const base = w => (w.unknown ? null : w.text.split('/').pop());
const cluster = (t, letters) => /^-[A-Za-z]+$/.test(t) && [...letters].some(l => t.includes(l));
const longPrefix = (t, option) => t.length >= 3 && t.startsWith('--') && option.startsWith(t);
const literally = (w, text) => w.unknown || w.text === text;

function branchDelete(t) {
  return t === '-d' || t === '-D' || longPrefix(t, '--delete') || cluster(t, 'dD');
}
function updateRefDelete(t) {
  return t === '-d' || longPrefix(t, '--stdin') || cluster(t, 'd');
}
function ghDelete(t) {
  if (t === '-d' || t === '--delete-branch') return true;
  if (t.startsWith('--delete-branch=')) return t !== '--delete-branch=false';
  return cluster(t, 'd');
}

// `git <global options> <subcommand> <args>`; `args` starts after `git`.
function gitRule(args) {
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (a.unknown || !a.text.startsWith('-')) break;
    if (a.text === '-c' || a.text === '--config-env') {
      const v = args[j + 1];
      if (v && (v.unknown || /^alias\./i.test(v.text))) return reason('an inline git alias (`-c alias.*`) can hide a branch delete');
      j += 2;
      continue;
    }
    if (/^-c.|^--config-env=/i.test(a.text) && /alias\./i.test(a.text)) return reason('an inline git alias (`-c alias.*`) can hide a branch delete');
    j += GIT_VALUE_OPTIONS.has(a.text) ? 2 : 1;
  }
  const sub = args[j];
  if (!sub) return null;
  const rest = args.slice(j + 1);
  const note = w => (w.unknown || sub.unknown ? UNKNOWN_NOTE : '');
  if (literally(sub, 'branch')) {
    for (const w of rest) {
      if (!w.unknown && w.text === '--') break;
      if (w.unknown || branchDelete(w.text)) return reason('`git branch` with a delete flag deletes a local branch') + note(w);
    }
  }
  if (literally(sub, 'worktree')) {
    const op = rest.find(w => w.unknown || !w.text.startsWith('-'));
    if (op && (op.unknown || op.text === 'remove' || op.text === 'prune')) return reason('`git worktree remove` or `prune` removes a worktree') + note(op);
  }
  if (literally(sub, 'update-ref')) {
    const w = rest.find(x => x.unknown || updateRefDelete(x.text));
    if (w) return reason('`git update-ref -d` (or `--stdin`) can delete a branch ref') + note(w);
  }
  return null;
}

// `gh <options> pr <options> merge <args>`; `args` starts after `gh`.
function ghRule(args) {
  let j = 0;
  const skipOptions = () => {
    while (j < args.length && !args[j].unknown && args[j].text.startsWith('-')) j += ['-R', '--repo'].includes(args[j].text) ? 2 : 1;
  };
  skipOptions();
  if (!args[j] || !literally(args[j], 'pr')) return null;
  const prUnknown = args[j].unknown;
  j++;
  skipOptions();
  if (!args[j] || !literally(args[j], 'merge')) return null;
  const mergeUnknown = args[j].unknown;
  for (const w of args.slice(j + 1)) {
    if (w.unknown || ghDelete(w.text)) {
      return reason('`gh pr merge` with `--delete-branch` deletes the branch whether or not the merge went through')
        + (w.unknown || prUnknown || mergeUnknown ? UNKNOWN_NOTE : '');
    }
  }
  return null;
}

// The raw text check, for text the parser cannot read or a script whose text it cannot see.
function mentions(src) {
  return (/\bgit\b/.test(src) && /\b(?:branch|worktree|update-ref)\b/.test(src)) || (/\bgh\b/.test(src) && /\bmerge\b/.test(src));
}
const UNSEEN = reason('this command runs text the guard cannot read (a shell reading stdin or a script whose text is unknown) and it mentions a branch, worktree or merge command');

function checkWords(words, src, depth) {
  let xargs = false;
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    const name = base(w);
    if (name && SHELLS.has(name)) {
      const c = words.slice(k + 1).findIndex(x => !x.unknown && (cluster(x.text, 'c') || x.text === '--command'));
      if (c < 0) { if (mentions(src)) return UNSEEN; continue; }
      const script = words[k + 2 + c];
      if (!script) continue;
      if (script.unknown) { if (mentions(src)) return UNSEEN; continue; }
      const r = analyze(script.text, depth + 1);
      if (r) return r;
      continue;
    }
    if (name === 'eval' || name === 'watch') {
      const rest = words.slice(k + 1).filter(x => x.unknown || !(name === 'watch' && x.text.startsWith('-')));
      if (rest.some(x => x.unknown)) { if (mentions(src)) return UNSEEN; continue; }
      const r = analyze(rest.map(x => x.text).join(' '), depth + 1);
      if (r) return r;
      continue;
    }
    if (name === 'env') {
      const s = words.slice(k + 1).findIndex(x => !x.unknown && (x.text === '-S' || x.text.startsWith('-S') || x.text.startsWith('--split-string')));
      if (s >= 0) {
        const opt = words[k + 1 + s].text;
        const inline = opt.startsWith('--split-string=') ? opt.slice('--split-string='.length) : (opt.length > 2 && opt.startsWith('-S') ? opt.slice(2) : null);
        const script = inline !== null ? { text: inline, unknown: false } : words[k + 2 + s];
        if (script && script.unknown) { if (mentions(src)) return UNSEEN; }
        else if (script) { const r = analyze(script.text, depth + 1); if (r) return r; }
      }
    }
    if (name === 'xargs' || name === 'parallel') xargs = true;
    const tail = words.slice(k + 1);
    // xargs appends words read from stdin, which the guard cannot see.
    if (xargs) tail.push({ text: '', unknown: true, quoted: false });
    if (w.unknown || name === 'git') { const r = gitRule(tail); if (r) return r; }
    if (w.unknown || name === 'gh') { const r = ghRule(tail); if (r) return r; }
  }
  return null;
}

function analyze(src, depth = 0) {
  if (depth > MAX_DEPTH) return reason('the command nests shells too deeply to check');
  const commands = [];
  try {
    new Parser(src, commands).list(null);
  } catch (error) {
    if (!(error instanceof ParseError)) throw error;
    return mentions(src) ? reason(`the guard cannot parse this command (${error.message}) and it mentions a branch, worktree or merge command`) : null;
  }
  for (const words of commands) {
    const r = checkWords(words, src, depth);
    if (r) return r;
  }
  return null;
}

// Returns null when the command may run, or the reason it is refused.
function checkCommand(command) {
  if (typeof command !== 'string') return null;
  return analyze(command);
}

module.exports = { checkCommand };
