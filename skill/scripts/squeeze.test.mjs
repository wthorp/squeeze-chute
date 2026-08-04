import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  activeIssueWorktrees,
  agentName,
  branchName,
  initializeWorktree,
  main,
  mergeConfig,
  missingRoles,
  rolePrompt,
  safeContextFiles,
  shouldInitialize,
  slugify,
  worktreeCommand,
} from './squeeze.mjs';

test('ships the requested role and concurrency defaults', () => {
  assert.equal(DEFAULT_CONFIG.maxActiveIssues, 8);
  assert.equal(DEFAULT_CONFIG.roles.planner.kind, 'codex');
  assert.ok(DEFAULT_CONFIG.roles.owner.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(DEFAULT_CONFIG.roles.validator.args.includes('--dangerously-skip-permissions'));
});

test('merges repository values, init, and individual role definitions', () => {
  const config = mergeConfig(
    { base: 'upstream/main', init: ['npm', 'install'], roles: { planner: { kind: 'opencode', args: ['--model', 'x'] } } },
    { init: ['pnpm', 'install', '--frozen-lockfile'], roles: { planner: { args: ['--model', 'y'] }, owner: { kind: 'cursor' } } },
  );
  assert.equal(config.base, 'upstream/main');
  assert.deepEqual(config.init, ['pnpm', 'install', '--frozen-lockfile']);
  assert.deepEqual(config.roles.planner, { kind: 'opencode', args: ['--model', 'y'] });
  assert.deepEqual(config.roles.owner, { kind: 'cursor', args: [] });
});

test('rejects invalid roles, init commands, and traversal', () => {
  assert.throws(() => mergeConfig({}, { roles: { owner: { kind: '../shell' } } }), /invalid role/);
  assert.throws(() => mergeConfig({}, { init: 'pnpm install' }), /config.init/);
  assert.throws(() => mergeConfig({}, { init: [''] }), /config.init/);
  assert.throws(() => mergeConfig({}, { init: ['pnpm', 1] }), /config.init/);
  assert.throws(() => safeContextFiles('/repo', ['../secret']), /escapes/);
  assert.throws(() => safeContextFiles('/repo', ['/tmp/secret']), /repository-relative/);
});

test('creates safe bounded slugs and globally unique names', () => {
  assert.equal(slugify(' Fix: Café / path; $(touch NO) '), 'fix-cafe-path-touch-no');
  assert.equal(branchName(30, 'A'.repeat(100), 'issue/'), `issue/30-${'a'.repeat(48)}`);
  assert.equal(agentName(30, 'owner'), 'i30-owner');
  assert.equal(agentName(31, 'owner'), 'i31-owner');
  assert.ok(agentName(123456789, 'implementer').length <= 32);
});

test('enforces active issue counting by open Herdr workspaces', () => {
  const items = [
    { branch: 'issue/1-one', open_workspace_id: 'w1' },
    { branch: 'issue/2-two' },
    { branch: 'feature/x', open_workspace_id: 'w2' },
  ];
  assert.deepEqual(activeIssueWorktrees(items, 'issue/'), [items[0]]);
  assert.equal(activeIssueWorktrees(items, 'issue/').length >= DEFAULT_CONFIG.maxActiveIssues, false);
});

test('idempotency detects complete and partially started role teams', () => {
  const tabs = ['owner', 'planner', 'implementer', 'validator'].map((label, index) => ({ label, tab_id: `t${index}` }));
  const panes = tabs.map((tab, index) => ({ tab_id: tab.tab_id, pane_id: `p${index}` }));
  const agents = ['owner', 'planner', 'implementer', 'validator'].map((role, index) => ({ name: agentName(30, role), pane_id: `p${index}` }));
  assert.deepEqual(missingRoles(30, tabs, panes, agents), []);
  assert.deepEqual(missingRoles(30, tabs, panes, agents.slice(0, 2)), ['implementer', 'validator']);
  assert.equal(shouldInitialize(30, []), true);
  assert.equal(shouldInitialize(30, [{ name: 'i30-owner' }]), false);
  assert.equal(shouldInitialize(30, [{ name: 'i31-owner' }]), true);
});

test('runs init as literal arguments in the worktree and propagates failure', () => {
  const calls = [];
  const runner = {
    run(command, args, options) {
      calls.push([command, args, options]);
      if (command === 'bad') throw new Error('init failed');
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  assert.equal(initializeWorktree(runner, '/repo with spaces', ['pnpm', 'install', '--frozen-lockfile']), true);
  assert.deepEqual(calls[0], ['pnpm', ['install', '--frozen-lockfile'], { cwd: '/repo with spaces' }]);
  assert.equal(initializeWorktree(runner, '/repo', [], true), false);
  assert.equal(initializeWorktree(runner, '/repo', ['pnpm', 'install'], false), false);
  assert.throws(() => initializeWorktree(runner, '/repo', ['bad']), /init failed/);
});

test('builds literal worktree command arguments without shell interpolation', () => {
  const title = '#30 fix; touch /tmp/pwned';
  const [command, args] = worktreeCommand({ repoRoot: '/repo with spaces', branch: 'issue/30-fix', base: 'origin/main', title, branchExists: false });
  assert.equal(command, 'herdr');
  assert.deepEqual(args, ['worktree', 'create', '--cwd', '/repo with spaces', '--branch', 'issue/30-fix', '--base', 'origin/main', '--label', title, '--no-focus', '--json']);
  assert.equal(args.includes('sh'), false);
});

test('existing paths and branches select reopen commands', () => {
  assert.equal(worktreeCommand({ repoRoot: '/r', branch: 'b', base: 'origin/main', title: 'x', existingPath: '/w' })[1][1], 'open');
  assert.deepEqual(worktreeCommand({ repoRoot: '/r', branch: 'b', base: 'origin/main', title: 'x', branchExists: true })[1].slice(0, 2), ['worktree', 'open']);
});

test('validator cannot pass without all required tests and an unchanged worktree', () => {
  const issue = { url: 'https://example/30' };
  const validator = rolePrompt('validator', 30, issue, 'origin/main', ['AGENTS.md']);
  const owner = rolePrompt('owner', 30, issue, 'origin/main', ['AGENTS.md']);
  assert.match(validator, /run every test suite required/);
  assert.match(validator, /Never make a failure pass by changing a test/);
  assert.match(validator, /failed, skipped, blocked, or unrun required suite means validation failed/);
  assert.match(validator, /git diff --exit-code/);
  assert.match(owner, /only after the validator reports that every repository-required and issue-required test suite passed/);
  assert.match(owner, /validation left tracked files unchanged/);
});

test('--dry-run resolves init without mutation commands', () => {
  const calls = [];
  const runner = {
    env: { HERDR_ENV: '1' },
    run(command, args) {
      calls.push([command, args]);
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: '/repo', stderr: '' };
      if (command === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
      if (command === 'herdr' && args[0] === 'integration') return { status: 0, stdout: 'codex: current (v1)\nclaude: current (v1)', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    json(command, args) {
      calls.push([command, args]);
      if (command === 'gh' && args[0] === 'issue') return { number: 30, title: 'Safe title', state: 'OPEN', body: '', url: 'https://example/30' };
      if (command === 'herdr' && args[0] === 'worktree') return { result: { worktrees: [] } };
      throw new Error(`unexpected JSON command: ${command} ${args.join(' ')}`);
    },
  };
  const original = console.log;
  let output = '';
  console.log = (value) => { output = value; };
  try { main(['start', '30', '--dry-run'], runner); } finally { console.log = original; }
  assert.deepEqual(JSON.parse(output).init, []);
  assert.equal(calls.some(([command, args]) => command === 'git' && args[0] === 'fetch'), false);
  assert.equal(calls.some(([command, args]) => command === 'herdr' && ['create', 'open', 'remove'].includes(args[1])), false);
});

function cleanupRunner({ dirty = false, issueState = 'OPEN', mergedAt = null } = {}) {
  const calls = [];
  return {
    calls,
    env: { HERDR_ENV: '1' },
    run(command, args) {
      calls.push([command, args]);
      if (command === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { status: 0, stdout: '/repo', stderr: '' };
      if (command === 'git' && args[0] === 'status') return { status: 0, stdout: dirty ? ' M file' : '', stderr: '' };
      if (command === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'origin/issue/30-safe', stderr: '' };
      if (command === 'git' && args[0] === 'rev-list') return { status: 0, stdout: '0', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    json(command, args) {
      calls.push([command, args]);
      if (command === 'herdr' && args[0] === 'worktree') return { result: { worktrees: [{ branch: 'issue/30-safe', path: '/worktree', open_workspace_id: 'w30' }] } };
      if (command === 'gh' && args[0] === 'issue') return { state: issueState };
      if (command === 'gh' && args[0] === 'pr') return [{ state: mergedAt ? 'MERGED' : 'OPEN', mergedAt }];
      throw new Error(`unexpected JSON command: ${command} ${args.join(' ')}`);
    },
  };
}

test('cleanup refuses dirty worktrees', () => {
  const runner = cleanupRunner({ dirty: true });
  assert.throws(() => main(['cleanup', '30'], runner), /worktree is dirty/);
  assert.equal(runner.calls.some(([command, args]) => command === 'herdr' && args[1] === 'remove'), false);
});

test('cleanup refuses an open issue with an unmerged PR', () => {
  const runner = cleanupRunner();
  assert.throws(() => main(['cleanup', '30'], runner), /issue is open and PR is not merged/);
  assert.equal(runner.calls.some(([command, args]) => command === 'herdr' && args[1] === 'remove'), false);
});
