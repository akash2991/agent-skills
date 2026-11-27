'use strict';

// Branch guard (FAC-47). It refuses a shell command, before it runs, that would delete a local branch
// (`git branch -d/-D/--delete`, `git update-ref -d`), remove or prune a worktree (`git worktree remove|prune`),
// or merge a pull request and delete its branch (`gh pr merge -d/--delete-branch`). Those belong to
// `merge-pr.js`, which deletes nothing until GitHub reports the merge, and `agent-env.js teardown`, which removes only
// what spawn created. Both run git as child processes, which no harness hook sees, so they need no exception.
//
// The decision is deterministic: a shell parse of the command text, with no model and no repository reads.
//
// What it promises: the guarded commands are refused when they are written as commands, directly or through a
// wrapper (`sudo`, `env`, `xargs`, `sh -c`, `eval`, a substitution, git's own `git-branch` programs). A value the
// shell only knows when the command runs ($VAR, $(...), `...`, $'...', a leading glob, a brace expansion) matches
// anything: as a flag of a guarded command it is a delete flag, and as the subcommand of `git` or `gh` it is a
// guarded command. Text the guard cannot read (a parse error, a shell reading stdin, an `eval` or `sh -c` of a
// variable, a command name in a variable) is refused when the rest of the line names a guarded command.
//
// What it does not promise: it is a check on habit, not a sandbox. It does not see a command inside a script file
// or a program the agent runs (`bash x.sh`, `python -c`, `node -e`), a git or gh alias defined in config, a shell
// alias or function defined outside the command, a glob in the middle of a word, or other git commands whose side
// effect removes a branch or worktree (`git fetch --prune` into refs/heads, `git gc` with a prune setting). The
// git-level backstop for those is FAC-49.

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish', 'su', 'runuser']);
const GIT_VALUE_OPTIONS = new Set(['-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path', '--attr-source', '--list-cmds']);
const PUSH_VALUE_OPTIONS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '-t', '--subject', '-b', '--body', '-F', '--body-file', '-A', '--author-email', '--match-head-commit']);
const SHELL_VALUE_OPTIONS = new Set(['-o', '+o', '-O', '+O', '--rcfile', '--init-file']);
const MAX_DEPTH = 8;
const MAX_LENGTH = 50000;
const GIT_CONFIG_ENV = /^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)=/;

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
      if (words.length) { words.src = src; words.end = this.i; this.out.push(words); }
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
      if (c === '(' && src[this.i + 1] === '(' && words.length === 0) {
        // An arithmetic command `(( ... ))`: its `<<` is a shift, not a here-document. It holds no commands, so text
        // in it that names one of the guarded commands is something this reader does not understand.
        let j = this.i + 2;
        let open = 2;
        while (j < src.length && open > 0) { if (src[j] === '(') open++; else if (src[j] === ')') open--; j++; }
        if (open > 0 || src[j - 2] !== ')') throw new ParseError('unreadable (( ))');
        if (mentions(src.slice(this.i, j))) throw new ParseError('unreadable (( ))');
        this.i = j;
        continue;
      }
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
        if (src[this.i + 1] === '(') { this.i += 2; this.list(')'); redirect = false; continue; }
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
    const w = { text: '', unknown: false, quoted: false, at: this.i };
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
        w.splits = true;
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
        if (this.dollar()) { w.unknown = true; w.splits = true; continue; }
        w.text += '$';
        this.i++;
        continue;
      }
      if (!w.quoted && w.text === '' && '*?['.includes(c)) { w.unknown = true; w.splits = true; }
      if (c === '{') brace = true;
      w.text += c;
      this.i++;
    }
    if (brace && w.text.length > 1 && /,|\.\./.test(w.text)) { w.unknown = true; w.splits = true; }
    w.to = this.i;
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

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const EXEC_ACTIONS = new Set(['-exec', '-execdir', '-ok', '-okdir']);
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', 'time']);
// Words that run the words after them as a command.
// Each maps to its options that take a separate value, so the value is not mistaken for the program it runs.
const WRAPPERS = new Map([
  ['sudo', ['-u', '-g', '-h', '-p', '-C', '-D', '-R', '-T', '-U', '-r', '-t', '--user', '--group', '--host', '--prompt', '--chdir', '--chroot']],
  ['doas', ['-u', '-C']], ['env', ['-u', '-C', '--unset', '--chdir']], ['command', []], ['builtin', []], ['exec', ['-a']], ['nohup', []],
  ['nice', ['-n', '--adjustment']], ['ionice', ['-c', '-n', '-p', '--class', '--classdata']], ['timeout', ['-s', '-k', '--signal', '--kill-after']],
  ['stdbuf', ['-i', '-o', '-e']], ['setsid', []], ['caffeinate', ['-t', '-w']],
  ['xargs', ['-I', '-n', '-L', '-P', '-s', '-E', '-d', '-a', '-R', '-S', '--max-args', '--max-procs', '--max-lines', '--delimiter', '--arg-file', '--replace']],
  ['parallel', ['-j', '--jobs']], ['watch', ['-n', '--interval']], ['eval', []],
]);
// The index of the program a command runs: its name, or, after wrappers, the first word that is not a wrapper's option,
// option value or assignment (`sudo -u deploy git`, `timeout 30 git`, `sudo /usr/bin/grep git` runs grep). An unreadable
// name is passed over like a wrapper without options, since it may be one. -1 when there is none.
function programIndex(words, head) {
  let i = head;
  for (;;) {
    if (i < 0 || i >= words.length) return -1;
    const name = base(words[i]);
    if (name !== null && !WRAPPERS.has(name)) return i;
    const values = name === null ? [] : WRAPPERS.get(name);
    let j = i + 1;
    let duration = name === 'timeout';
    for (; j < words.length; j++) {
      const x = words[j];
      if (/^[-+]/.test(x.text)) { if (!x.unknown && values.includes(x.text)) j++; continue; }
      if (!x.unknown && ASSIGNMENT.test(x.text)) continue;
      if (duration && !x.unknown) { duration = false; continue; }
      break;
    }
    i = j;
  }
}
// The index of a simple command's name: after variable assignments and shell keywords (`if git ...; then`).
const headIndex = words => words.findIndex((w, i) => w.unknown || !(ASSIGNMENT.test(w.text) || (!w.quoted && KEYWORDS.has(w.text))
  || (w.text.startsWith('-') && i > 0 && !words[i - 1].unknown && words[i - 1].text === 'time'))); // `time -p git ...`
const base = w => (w.unknown ? null : w.text.split('/').pop());
// A cluster of short options (`-qd`). After a letter that takes a value (`-odeploy`), the rest is that value, not flags.
const cluster = (t, letters, valueLetters = '') => {
  if (!/^-[A-Za-z]+$/.test(t)) return false;
  const stop = [...t].findIndex((l, i) => i > 0 && valueLetters.includes(l));
  const flags = stop < 0 ? t : t.slice(0, stop);
  return [...letters].some(l => flags.includes(l));
};
const longPrefix = (t, option) => t.length >= 3 && t.startsWith('--') && option.startsWith(t);
const literally = (w, text) => w.unknown || w.text === text;

function branchDelete(t) {
  return t === '-d' || t === '-D' || longPrefix(t, '--delete') || cluster(t, 'dD');
}
function updateRefDelete(t) {
  return t === '-d' || longPrefix(t, '--stdin') || cluster(t, 'd');
}
function pushDelete(t) {
  return cluster(t, 'd', 'o') || longPrefix(t, '--delete') || longPrefix(t, '--prune') || longPrefix(t, '--mirror');
}
function ghDelete(t) {
  if (t === '-d' || t === '--delete-branch') return true;
  if (t.startsWith('--delete-branch=')) return t !== '--delete-branch=false';
  return cluster(t, 'd', 'tbFAR');
}

// `git <global options> <subcommand> <args>`; `args` starts after `git`.
function gitRule(args, literalGit) {
  let j = 0;
  while (j < args.length) {
    const a = args[j];
    if (!a.text.startsWith('-') || a.splits) break;
    if (a.text === '-c' || a.text === '--config-env') {
      const v = args[j + 1];
      if (v && (v.unknown || /^alias\./i.test(v.text) || mentions(v.text))) return reason('an inline git alias or command (`-c alias.*`, or a `-c` value that names one of these commands) can hide a branch delete');
      j += 2;
      continue;
    }
    if (/^-c.|^--config-env=/i.test(a.text) && (/alias\./i.test(a.text) || mentions(a.text))) return reason('an inline git alias or command (`-c alias.*`, or a `-c` value that names one of these commands) can hide a branch delete');
    j += GIT_VALUE_OPTIONS.has(a.text) ? 2 : 1;
  }
  const sub = args[j];
  if (!sub) return null;
  // After a literal `git`, a subcommand the shell only knows at run time can be `branch -D x` in one word.
  if (literalGit && sub.unknown) return reason('`git` with a subcommand the guard cannot read could be a branch delete or a worktree removal') + UNKNOWN_NOTE;
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
    // `update-ref <ref> <new> [<old>]`: an all-zero new value deletes the ref; an all-zero old value only asks that it be new.
    const operands = rest.filter((x, i) => !x.text.startsWith('-') && !(i > 0 && rest[i - 1].text === '-m'));
    if (operands[1] && /^0{7,}$/.test(operands[1].text)) return reason('`git update-ref` with an all-zero new value deletes the ref');
  }
  if (!sub.unknown && sub.text === 'push') {
    // A push into this repository (`.`, a path) deletes a local branch with --delete or a `:branch` refspec.
    let k = 0;
    while (k < rest.length && !rest[k].unknown && rest[k].text.startsWith('-')) k += PUSH_VALUE_OPTIONS.has(rest[k].text) ? 2 : 1;
    const repoAt = rest.findIndex(w => w.text === '--repo' || w.text.startsWith('--repo='));
    const remote = repoAt < 0 ? rest[k] : (rest[repoAt].text === '--repo' ? rest[repoAt + 1] : { ...rest[repoAt], text: rest[repoAt].text.slice('--repo='.length) });
    // A path: `.`, `./x`, `/x`, `~/x`, `file:`, or a name with a slash and no `host:` or `scheme://` in it.
    const local = remote && (remote.unknown || /^(?:\.|\/|~|file:)/.test(remote.text) || (remote.text.includes('/') && !remote.text.includes(':')));
    const deletes = w => w !== remote && w !== rest[repoAt] && (w.unknown || pushDelete(w.text) || /^\+?:/.test(w.text));
    if (local && rest.some(deletes)) {
      return reason('`git push` into a local repository with a delete flag or a `:branch` refspec deletes a local branch')
        + (rest.some(w => w.unknown) ? UNKNOWN_NOTE : '');
    }
  }
  return null;
}

// `gh <options> pr <options> merge <args>`; `args` starts after `gh`.
function ghRule(args, literalGh) {
  let j = 0;
  const skipOptions = () => {
    while (j < args.length && !args[j].splits && args[j].text.startsWith('-')) j += GH_VALUE_OPTIONS.has(args[j].text) ? 2 : 1;
  };
  skipOptions();
  // After a literal `gh`, a subcommand the shell only knows at run time can be `pr merge -d` in one word.
  const hidden = reason('`gh` with a subcommand the guard cannot read could be `pr merge --delete-branch`') + UNKNOWN_NOTE;
  if (literalGh && args[j] && args[j].unknown) return hidden;
  if (!args[j] || !literally(args[j], 'pr')) return null;
  const prUnknown = args[j].unknown;
  j++;
  skipOptions();
  if (literalGh && args[j] && args[j].unknown) return hidden;
  if (!args[j] || !literally(args[j], 'merge')) return null;
  const mergeUnknown = args[j].unknown;
  const rest = args.slice(j + 1);
  for (let k = 0; k < rest.length; k++) {
    const w = rest[k];
    // The value of an option that takes one (a title, a body) is never a flag, even when it is unknown.
    // An unquoted expansion can split into the value and another flag, so it is not skipped.
    if (!w.unknown && GH_VALUE_OPTIONS.has(w.text) && rest[k + 1] && !rest[k + 1].splits) { k++; continue; }
    if (/^(?:--(?:subject|body|body-file|author-email|match-head-commit|repo)=|-[tbFAR])/.test(w.text) && w.unknown && !w.splits) continue;
    if (/^--(?:subject|body|body-file|author-email|match-head-commit|repo)=/.test(w.text) && !w.unknown) continue;
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
// The same check for text the guard cannot see, over the command line without the git and gh commands that were read
// and checked on their own: `git worktree list && bash -c "$X"` names no hidden command, `X='git branch -D x'; $X` does.
function hiddenMentions(src, commands) {
  let rest = src;
  for (const words of commands) {
    if (words.src !== src) continue;
    const h = headIndex(words);
    if (h < 0 || words[h].unknown || !['git', 'gh'].includes(base(words[h]))) continue;
    // Only the words written bare are left out: a quoted argument can hold a command for a shell to run later
    // (`git for-each-ref --format='git branch -D %(refname)' | sh`).
    for (const w of words.slice(h)) if (!w.quoted && !w.unknown) rest = rest.slice(0, w.at) + ' '.repeat(w.to - w.at) + rest.slice(w.to);
  }
  return mentions(rest);
}
const UNSEEN = reason('this command runs text the guard cannot read (a shell reading stdin or a script whose text is unknown) and it mentions a branch, worktree or merge command');

// Commands that never run one of their arguments as a command. After such a command's name, a word like `bash` or
// `eval` is data (a branch name, a search pattern, a path), not a shell. Every other command, and any command whose
// name is unknown, may run its arguments (sudo, env, nohup, find -exec, ...), so its words stay candidates.
const DATA_COMMANDS = new Set(['gh', 'grep', 'egrep', 'fgrep', 'rg', 'echo', 'printf', 'cat', 'ls', 'cd', 'pwd', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln',
  'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'tr', 'test', '[', 'which', 'type', 'basename', 'dirname', 'diff', 'file', 'stat', 'chmod']);
// git subcommands that take only data. Others (bisect run, rebase --exec, submodule foreach, ...) can run a command.
const GIT_DATA_SUBCOMMANDS = new Set(['branch', 'worktree', 'update-ref', 'checkout', 'switch', 'status', 'log', 'show', 'diff', 'add', 'commit', 'push', 'fetch',
  'merge', 'tag', 'remote', 'restore', 'reset', 'rev-parse', 'ls-files', 'grep', 'stash', 'clone', 'init', 'cherry-pick', 'revert', 'blame', 'merge-base', 'rev-list', 'for-each-ref', 'show-ref']);

// The index of the command name when the words after it are only data, else -1.
function dataCommand(words) {
  const head = headIndex(words);
  if (head < 0) return -1;
  const name = base(words[head]);
  if (name && DATA_COMMANDS.has(name)) return head;
  // The first literal `git`, wherever it stands (`sudo git branch feature/bash`), when its subcommand takes only data.
  const h = words.findIndex(w => base(w) === 'git');
  if (h < 0) return -1;
  let j = h + 1;
  while (j < words.length && !words[j].splits && words[j].text.startsWith('-')) {
    j += words[j].text === '-c' || words[j].text === '--config-env' || GIT_VALUE_OPTIONS.has(words[j].text) ? 2 : 1;
  }
  const sub = words[j];
  return sub && !sub.unknown && GIT_DATA_SUBCOMMANDS.has(sub.text) ? h : -1;
}

function checkWords(words, src, depth, hidden) {
  let xargs = false;
  const dataHead = dataCommand(words);
  // A command whose name the shell only knows at run time (`$X`, `"$@"`) can be any of the guarded commands.
  const head = headIndex(words);
  if (head >= 0 && words[head].unknown && words[head].text === '' && hidden()) return UNSEEN;
  // `git` and `gh` are in command position when they are the program the command runs, or the program of a find
  // action. Elsewhere (`npm view git "$FIELD"`, `xargs grep -n git`) the word may be data, so only a literal
  // guarded command after it is refused.
  const program = programIndex(words, head);
  const isFind = program >= 0 && base(words[program]) === 'find';
  for (let k = 0; k < words.length; k++) {
    const w = words[k];
    // An argument of a data command is data: `echo git branch -D x` prints, `git branch feature/bash` names a branch.
    if (dataHead >= 0 && k > dataHead) break;
    const name = base(w);
    // git reads config, and so aliases, from these variables when they are set for a command.
    if (GIT_CONFIG_ENV.test(w.text) && (head < 0 || k < head || ['env', 'export', 'declare', 'typeset', 'local', 'readonly'].includes(base(words[head])))) {
      return reason('git config set through the environment (`GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`) can define an alias that hides a branch delete');
    }
    if (name && SHELLS.has(name)) {
      const after = words.slice(k + 1);
      const option = x => /^[-+]/.test(x.text);
      if (after.some(x => !x.unknown && (cluster(x.text, 'c') || x.text === '--command'))) {
        // With -c the script is the first operand, wherever it stands (`bash -c -- '...'`, `bash -c -x '...'`,
        // `bash -o pipefail -c '...'`); the words after it are its positional parameters, which are data.
        const at = after.findIndex((x, i) => x.unknown || (!option(x) && !(i > 0 && SHELL_VALUE_OPTIONS.has(after[i - 1].text))));
        // No script operand: after xargs it comes from input the guard cannot see.
        if (at < 0) { if (xargs && hidden()) return UNSEEN; continue; }
        // The positional data ends where this invocation does: at the end of the command, or at the `;` or `+` that closes a
        // `find -exec` action, after which the next action is read.
        const close = words.findIndex((x, i) => i > k + 1 + at && !x.unknown && (x.text === ';' || (x.text === '+' && words[i - 1].text === '{}')));
        if (after[at].unknown) { if (hidden()) return UNSEEN; }
        else { const r = analyze(after[at].text, depth + 1); if (r) return r; }
        if (close < 0) break;
        k = close;
        continue;
      }
      // Without -c: a literal operand is a script file, which the guard does not read (a known limit). With no
      // operand, or `-s`, or a word it cannot see, the shell reads its commands from somewhere the guard cannot.
      const file = after.some(x => !x.unknown && !option(x)) && !after.some(x => x.unknown || cluster(x.text, 's')) && name !== 'su' && name !== 'runuser';
      if (!file && hidden()) return UNSEEN;
      continue;
    }
    if (name === 'eval' || name === 'watch') {
      const rest = words.slice(k + 1).filter(x => x.unknown || !(name === 'watch' && x.text.startsWith('-')));
      if (rest.some(x => x.unknown)) { if (hidden()) return UNSEEN; continue; }
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
        if (script && script.unknown) { if (hidden()) return UNSEEN; }
        else if (script) {
          // env passes the words after the split string to its command: `env -S "git branch" -D x`.
          const more = words.slice(inline !== null ? k + 2 + s : k + 3 + s).map(x => (x.unknown ? '"$UNKNOWN"' : `'${x.text.replace(/'/g, '\'\\\'\'')}'`));
          const r = analyze([script.text, ...more].join(' '), depth + 1);
          if (r) return r;
        }
      }
    }
    if (name === 'xargs' || name === 'parallel') xargs = true;
    const tail = words.slice(k + 1);
    // xargs appends words read from stdin, which the guard cannot see.
    if (xargs) tail.push({ text: '', unknown: true, quoted: false });
    const position = k === program || (isFind && k > program && EXEC_ACTIONS.has(words[k - 1].text));
    if (w.unknown || name === 'git') { const r = gitRule(tail, name === 'git' && position); if (r) return r; }
    if (w.unknown || name === 'gh') { const r = ghRule(tail, name === 'gh' && position); if (r) return r; }
    // git's own programs: `git-branch -D x`, `"$(git --exec-path)/git-branch" -D x`.
    const dashed = /(?:^|\/)git-([a-z][a-z-]*)$/.exec(w.text);
    if (dashed) { const r = gitRule([{ text: dashed[1], unknown: false, quoted: false }, ...tail], true); if (r) return r; }
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
  let hiddenValue;
  const hidden = () => (hiddenValue === undefined ? (hiddenValue = hiddenMentions(src, commands)) : hiddenValue);
  for (const words of commands) {
    const r = checkWords(words, src, depth, hidden);
    if (r) return r;
  }
  return null;
}

// Returns null when the command may run, or the reason it is refused.
function checkCommand(command) {
  if (typeof command !== 'string') return null;
  // The check is slower than linear in the number of words; a very long line is not read at all.
  if (command.length > MAX_LENGTH) return mentions(command) ? reason('the command is too long for the guard to read and it mentions a branch, worktree or merge command') : null;
  return analyze(command);
}

module.exports = { checkCommand };
