// No imports: the PreToolUse entry loads this on every Bash call, before anything heavy.

/**
 * Shell commands that change something hard to undo: history, packages, files, services,
 * remote hosts, databases. Only these start the tool guard, since it runs on every Bash call.
 * A tool inside a quoted string ("grep 'git push'") counts too; Jev throws those out.
 * ponytail: hand list; add a tool when a learning about it never surfaced.
 */
const RISKY = [
  String.raw`git\s+(?:-C\s+\S+\s+)?(?:push|commit|reset|rebase|merge|clean|stash|tag|restore|rm|filter-branch|branch\s+-[dD]|checkout\s+--|worktree\s+remove)`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+(?:publish|unpublish|install|i|add|remove|uninstall|update|upgrade|version|link)`,
  String.raw`(?:npm|pnpm|yarn|bun)\s+run\s+\S*(?:deploy|migrate|publish|release)\S*`,
  String.raw`\S*(?:deploy|migrate|publish|release)\S*\.sh`,
  String.raw`(?:pip3?|pipx|apt(?:-get)?|brew|cargo)\s+(?:install|uninstall|remove|upgrade)`,
  String.raw`(?:rm|rmdir|shred|truncate|dd|chmod|chown|kill|pkill|killall|sudo|crontab|systemctl|service|reboot|shutdown)`,
  String.raw`(?:docker|docker-compose|kubectl|helm|ssh|scp|rsync|rclone|rmapi|sqlite3|psql|mysql|mongosh|redis-cli)`,
  String.raw`gh\s+(?:pr\s+merge|release|secret|workflow\s+run|repo\s+(?:delete|edit|rename))`,
  String.raw`curl\s.*-X\s*(?:POST|PUT|PATCH|DELETE)`,
];
// At a command position: start, or after a separator, subshell or env assignment.
const RISKY_COMMAND = new RegExp(`(?:^|[\\s;&|(\`])(?:${RISKY.join('|')})(?=$|[\\s;&|)\`'"])`);

export function isRiskyCommand(command: string): boolean {
  return RISKY_COMMAND.test(command);
}

/**
 * The command without credentials, before it is searched or sent to Jev: agents put tokens in
 * env assignments, headers and connection strings. ponytail: pattern-based, a token in an
 * unusual spot can slip through; send only the description if that ever shows up.
 */
export function scrubCommand(command: string): string {
  // Bearer first: "Authorization: Bearer x" would otherwise only lose the word "Bearer".
  return command
    .replace(/\b(Bearer|Basic|token)\s+[\w.~+/=-]+/gi, '$1 …')
    .replace(/(\b[\w-]*(?:token|key|secret|passw(?:or)?d|pass|pwd|auth\w*|credential\w*)[\w-]*\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1…')
    .replace(/(\/\/[^\s/:@]+:)[^\s/@]+@/g, '$1…@')
    // No "/" in the class: a path's parts stay for the caller to read.
    .replace(/[A-Za-z0-9+_=-]{24,}/g, '…');
}
