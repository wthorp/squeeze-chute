#!/usr/bin/env node
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, watch } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const MAX_UNTRACKED = 1024 * 1024;
const faint = '\x1b[2m';
const cyan = '\x1b[36m';
const reset = '\x1b[0m';

function git(cwd, args, allowFailure = false) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0 && !allowFailure) throw new Error((result.stderr || result.stdout).trim());
  return result.stdout;
}

function isBinary(path) {
  return readFileSync(path).subarray(0, 8192).includes(0);
}

export function renderSnapshot({ worktree, issue, branch, base }) {
  const head = git(worktree, ['rev-parse', '--short', 'HEAD']).trim();
  const mergeBase = git(worktree, ['merge-base', base, 'HEAD']).trim();
  const status = git(worktree, ['status', '--short', '--branch', '--untracked-files=all']).trimEnd();
  const commits = git(worktree, ['log', '--color=always', '--oneline', '--decorate', `${mergeBase}..HEAD`]).trimEnd();
  const trackedDiff = git(worktree, ['diff', '--color=always', '--no-ext-diff', '--find-renames', mergeBase, '--', '.']).trimEnd();
  const untracked = git(worktree, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const untrackedDiffs = [];
  const untrackedListed = [];
  for (const file of untracked) {
    const path = resolve(worktree, file);
    if (!existsSync(path) || !lstatSync(path).isFile()) continue;
    const size = lstatSync(path).size;
    if (size > MAX_UNTRACKED) untrackedListed.push(`${file} (${size} bytes, too large to render)`);
    else if (isBinary(path)) untrackedListed.push(`${file} (binary)`);
    else untrackedDiffs.push(git(worktree, ['diff', '--no-index', '--color=always', '--', '/dev/null', file], true).trimEnd());
  }
  const parts = [
    `${cyan}Squeeze #${issue}${reset}  ${branch}`,
    `${faint}base ${base}  HEAD ${head}${reset}`,
    '',
    `${cyan}WORKING TREE${reset}`,
    status || 'clean',
    '',
    `${cyan}COMMITS SINCE MERGE-BASE${reset}`,
    commits || 'none',
    '',
    `${cyan}DIFF AGAINST ${base}${reset}`,
    [trackedDiff, ...untrackedDiffs].filter(Boolean).join('\n') || 'none',
  ];
  if (untrackedListed.length) parts.push('', `${cyan}UNTRACKED NOT RENDERED${reset}`, ...untrackedListed);
  return `${parts.join('\n')}\n`;
}

export function createRedrawer(stream = process.stdout) {
  let previous;
  return (content) => {
    if (content === previous) return false;
    previous = content;
    stream.write(`\x1b[2J\x1b[H${content}`);
    return true;
  };
}

function watchRecursively(path, onChange) {
  try {
    return [watch(path, { recursive: true }, onChange)];
  } catch {
    return readdirSync(path, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => watch(resolve(entry.parentPath ?? entry.path, entry.name), onChange))
      .concat(watch(path, onChange));
  }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) values[argv[index]?.slice(2)] = argv[index + 1];
  if (!values.worktree || !values.issue || !values.branch || !values.base) throw new Error('usage: observe.mjs --worktree PATH --issue N --branch NAME --base REF');
  return { ...values, worktree: realpathSync(values.worktree) };
}

export function observe(options, { interval = 5000, debounce = 120, stream = process.stdout } = {}) {
  const redraw = createRedrawer(stream);
  let timer;
  const refresh = () => {
    try { redraw(renderSnapshot(options)); }
    catch (error) { redraw(`${cyan}Squeeze #${options.issue}${reset}\nobserver error: ${error.message}\n`); }
  };
  const schedule = () => { clearTimeout(timer); timer = setTimeout(refresh, debounce); };
  const gitPaths = git(options.worktree, ['rev-parse', '--path-format=absolute', '--git-dir', '--git-common-dir']).trim().split('\n');
  const watchers = [...new Set([options.worktree, ...gitPaths])].flatMap((path) => watchRecursively(path, schedule));
  const fallback = setInterval(refresh, interval);
  const close = () => { watchers.forEach((watcher) => watcher.close()); clearInterval(fallback); clearTimeout(timer); };
  process.once('SIGINT', () => { close(); process.exitCode = 130; });
  process.once('SIGTERM', () => { close(); process.exitCode = 143; });
  refresh();
  return close;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) observe(parseArgs(process.argv.slice(2)));
