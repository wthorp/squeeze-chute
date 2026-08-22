import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  DEFAULT_CONFIG,
  activeIssueWorktrees,
  agentName,
  branchName,
  encodedCommand,
  ensureRoles,
  initializeWorktree,
  launcherCommand,
  main,
  mergeConfig,
  missingRoles,
  observerCommand,
  rolePrompt,
  safeContextFiles,
  shouldInitialize,
  slugify,
  topology,
  worktreeCommand,
} from './squeeze.mjs';
import { createRedrawer, observe, renderSnapshot } from './observe.mjs';

function command(cwd, args) {
  const result = spawnSync(args[0], args.slice(1), { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('can be imported without a CLI argv path', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', `import(${JSON.stringify(new URL('./squeeze.mjs', import.meta.url).href)})`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('ships three roles and the requested concurrency defaults', () => {
  assert.equal(DEFAULT_CONFIG.maxActiveIssues, 8);
  assert.deepEqual(Object.keys(DEFAULT_CONFIG.roles), ['owner', 'implementer', 'validator']);
  assert.ok(DEFAULT_CONFIG.roles.owner.args.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.ok(DEFAULT_CONFIG.roles.validator.args.includes('--dangerously-skip-permissions'));
});

test('merges kind configs, ignores planner, supports commands, and kind switches back', () => {
  const commandConfig = ['onecli', 'run', '--agent', 'squeeze owner', '--', 'codex', '--yolo'];
  const configured = mergeConfig(
    { base: 'upstream/main', roles: { planner: { kind: '../ignored' }, owner: { command: commandConfig } } },
    { roles: { implementer: { kind: 'cursor' } } },
  );
  assert.equal(configured.base, 'upstream/main');
  assert.deepEqual(configured.roles.owner, { command: commandConfig });
  assert.deepEqual(configured.roles.implementer, { kind: 'cursor', args: [] });
  assert.equal(Object.hasOwn(configured.roles, 'planner'), false);
  assert.deepEqual(mergeConfig({ roles: { owner: { command: commandConfig } } }, { roles: { owner: { kind: 'codex' } } }).roles.owner, DEFAULT_CONFIG.roles.owner);
});

test('rejects mixed or invalid role commands, init commands, and traversal', () => {
  assert.throws(() => mergeConfig({}, { roles: { owner: { kind: '../shell' } } }), /invalid role/);
  assert.throws(() => mergeConfig({}, { roles: { owner: { command: [] } } }), /invalid role/);
  assert.throws(() => mergeConfig({}, { roles: { owner: { command: ['codex'], kind: 'codex' } } }), /mutually exclusive/);
  assert.throws(() => mergeConfig({ roles: { owner: { command: ['codex'] } } }, { roles: { owner: { args: ['--yolo'] } } }), /inherited command/);
  assert.throws(() => mergeConfig({}, { init: 'pnpm install' }), /config.init/);
  assert.throws(() => safeContextFiles('/repo', ['../secret']), /escapes/);
  assert.throws(() => safeContextFiles('/repo', ['/tmp/secret']), /repository-relative/);
});

test('encodes custom command boundaries without shell execution', () => {
  const args = ['space value', `quote'value`, '"double"', '$(touch /tmp/squeeze-no)', '; echo nope'];
  const wrapped = [process.execPath, '--input-type=module', '--eval', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...args];
  assert.deepEqual(JSON.parse(Buffer.from(encodedCommand(wrapped), 'base64url').toString()), wrapped);
  const result = spawnSync(...[launcherCommand(wrapped)[0], launcherCommand(wrapped).slice(1)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), args);
  assert.deepEqual(observerCommand('/repo with spaces', 30, 'issue/30-safe', 'origin/main').slice(0, 2), launcherCommand([]).slice(0, 2));
});

test('creates safe bounded slugs and globally unique names', () => {
  assert.equal(slugify(' Fix: Café / path; $(touch NO) '), 'fix-cafe-path-touch-no');
  assert.equal(branchName(30, 'A'.repeat(100), 'issue/'), `issue/30-${'a'.repeat(48)}`);
  assert.equal(agentName(30, 'owner'), 'i30-owner');
  assert.ok(agentName(123456789, 'implementer').length <= 32);
});

test('enforces active issue counting by open Herdr workspaces', () => {
  const items = [{ branch: 'issue/1-one', open_workspace_id: 'w1' }, { branch: 'issue/2-two' }, { branch: 'feature/x', open_workspace_id: 'w2' }];
  assert.deepEqual(activeIssueWorktrees(items, 'issue/'), [items[0]]);
});

test('detects compact and legacy topology and missing compact roles', () => {
  const tabs = [{ label: 'overview', tab_id: 't0' }, { label: 'workers', tab_id: 't1' }];
  const panes = [{ tab_id: 't0', pane_id: 'p0' }, { tab_id: 't0', pane_id: 'pd' }, { tab_id: 't1', pane_id: 'p1' }, { tab_id: 't1', pane_id: 'p2' }];
  const agents = [{ name: agentName(30, 'owner'), pane_id: 'p0' }, { name: agentName(30, 'implementer'), pane_id: 'p1' }, { name: agentName(30, 'validator'), pane_id: 'p2' }];
  assert.equal(topology(tabs), 'compact');
  assert.equal(topology([{ label: 'owner' }, { label: 'planner' }]), 'legacy');
  assert.deepEqual(missingRoles(30, tabs, panes, agents), []);
  assert.deepEqual(missingRoles(30, tabs, panes, agents.slice(0, 1)), ['implementer', 'validator']);
  assert.equal(shouldInitialize(30, []), true);
  assert.equal(shouldInitialize(30, [{ name: 'i30-owner' }]), false);
  assert.equal(shouldInitialize(30, [], 'legacy'), false);
});

test('runs init and worktree commands as literal arguments', () => {
  const calls = [];
  const runner = { run(commandName, args, options) { calls.push([commandName, args, options]); return { status: 0, stdout: '', stderr: '' }; } };
  assert.equal(initializeWorktree(runner, '/repo with spaces', ['pnpm', 'install']), true);
  assert.deepEqual(calls[0], ['pnpm', ['install'], { cwd: '/repo with spaces' }]);
  const [commandName, args] = worktreeCommand({ repoRoot: '/repo with spaces', branch: 'issue/30-fix', base: 'origin/main', title: '#30 fix; touch /tmp/pwned', branchExists: false });
  assert.equal(commandName, 'herdr');
  assert.equal(args.includes('sh'), false);
  assert.equal(worktreeCommand({ repoRoot: '/r', branch: 'b', base: 'origin/main', title: 'x', existingPath: '/w' })[1][1], 'open');
});

function topologyRunner(legacy = false) {
  const state = {
    tabs: legacy ? ['owner', 'planner', 'implementer', 'validator'].map((label, index) => ({ label, tab_id: `t${index}` })) : [{ label: '#30 issue', tab_id: 't0' }],
    panes: legacy ? [0, 1, 2, 3].map((index) => ({ tab_id: `t${index}`, pane_id: `p${index}` })) : [{ tab_id: 't0', pane_id: 'p0' }],
    agents: [], calls: [], observerRunning: false,
  };
  return {
    state,
    run(commandName, args, options = {}) {
      state.calls.push([commandName, args]);
      if (args[0] === 'tab' && args[1] === 'rename') state.tabs.find((tab) => tab.tab_id === args[2]).label = args[3];
      if (args[0] === 'pane' && args[1] === 'rename') state.panes.find((pane) => pane.pane_id === args[2]).label = args[3];
      if (args[0] === 'pane' && args[1] === 'process-info') return { status: state.observerRunning ? 0 : 1, stdout: state.observerRunning ? 'node observe.mjs' : '', stderr: '' };
      if (args[0] === 'pane' && args[1] === 'run') state.observerRunning = true;
      if (args[0] === 'agent' && args[1] === 'start') state.agents.push({ name: args[2], pane_id: args[args.indexOf('--pane') + 1], workspace_id: 'w30' });
      return { status: 0, stdout: '', stderr: '' };
    },
    json(commandName, args) {
      state.calls.push([commandName, args]);
      if (args[0] === 'tab' && args[1] === 'list') return { result: { tabs: state.tabs } };
      if (args[0] === 'pane' && args[1] === 'list') return { result: { panes: state.panes } };
      if (args[0] === 'agent' && args[1] === 'list') return { result: { agents: state.agents } };
      if (args[0] === 'tab' && args[1] === 'create') {
        const tab = { label: args[args.indexOf('--label') + 1], tab_id: `t${state.tabs.length}` };
        const pane = { tab_id: tab.tab_id, pane_id: `p${state.panes.length}` };
        state.tabs.push(tab); state.panes.push(pane);
        return { result: { tab, root_pane: pane } };
      }
      if (args[0] === 'pane' && args[1] === 'split') {
        const source = state.panes.find((pane) => pane.pane_id === args[2]);
        const pane = { tab_id: source.tab_id, pane_id: `p${state.panes.length}` };
        state.panes.push(pane);
        return { result: { pane } };
      }
      throw new Error(`unexpected JSON command: ${commandName} ${args.join(' ')}`);
    },
  };
}

test('creates overview/workers splits, starts observer, and omits planner', () => {
  const runner = topologyRunner();
  const result = ensureRoles(runner, 'w30', '/worktree', 30, { url: 'https://example/30', branch: 'issue/30-safe' }, DEFAULT_CONFIG, ['AGENTS.md']);
  assert.equal(result, 'compact');
  assert.deepEqual(runner.state.tabs.map((tab) => tab.label), ['overview', 'workers']);
  assert.deepEqual(runner.state.panes.map((pane) => pane.label), ['owner', 'diff', 'implementer', 'validator']);
  assert.deepEqual(runner.state.agents.map((agent) => agent.name), ['i30-owner', 'i30-impl', 'i30-valid']);
  assert.equal(runner.state.observerRunning, true);
  assert.equal(runner.state.calls.some(([, args]) => args.includes('planner')), false);
  assert.ok(runner.state.calls.some(([, args]) => args.includes('0.35')));
  assert.ok(runner.state.calls.some(([, args]) => args.includes('0.5')));
  const observerStarts = runner.state.calls.filter(([, args]) => args[0] === 'pane' && args[1] === 'run').length;
  ensureRoles(runner, 'w30', '/worktree', 30, { url: 'https://example/30', branch: 'issue/30-safe' }, DEFAULT_CONFIG, ['AGENTS.md']);
  assert.equal(runner.state.calls.filter(([, args]) => args[0] === 'pane' && args[1] === 'run').length, observerStarts);
});

test('leaves legacy workspaces completely untouched', () => {
  const runner = topologyRunner(true);
  assert.equal(ensureRoles(runner, 'w30', '/worktree', 30, { url: 'https://example/30', branch: 'issue/30-safe' }, DEFAULT_CONFIG, ['AGENTS.md']), 'legacy');
  assert.equal(runner.state.calls.some(([, args]) => ['rename', 'create', 'split', 'run', 'start', 'prompt'].includes(args[1])), false);
});

test('role contracts contain checkpoints, adversarial validation, and GitHub review only', () => {
  const issue = { url: 'https://example/30' };
  const prompts = Object.fromEntries(['owner', 'implementer', 'validator'].map((role) => [role, rolePrompt(role, 30, issue, 'origin/main', ['AGENTS.md'])]));
  assert.match(prompts.owner, /Stage, Changed, Risk, Checks, Next/);
  assert.match(prompts.owner, /human review of the final PR through GitHub/);
  assert.match(prompts.implementer, /Ponytail/);
  assert.match(prompts.validator, /Sverklo review_diff, test_map/);
  assert.match(prompts.validator, /missing meaningful adversarial case is validation failure/);
  assert.match(prompts.validator, /git diff --exit-code/);
  assert.doesNotMatch(Object.values(prompts).join('\n'), /planner|acceptance\/evidence|immutable-SHA|red-on-base/);
});

test('--dry-run reports compact topology, panes, launch modes, and observer without mutations', () => {
  const calls = [];
  const runner = {
    env: { HERDR_ENV: '1' },
    run(commandName, args) {
      calls.push([commandName, args]);
      if (commandName === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: '/repo', stderr: '' };
      if (commandName === 'git' && args[0] === 'show-ref') return { status: 1, stdout: '', stderr: '' };
      if (commandName === 'herdr' && args[0] === 'integration') return { status: 0, stdout: 'codex: current (v1)\nclaude: current (v1)', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    json(commandName, args) {
      calls.push([commandName, args]);
      if (commandName === 'gh' && args[0] === 'issue') return { number: 30, title: 'Safe title', state: 'OPEN', url: 'https://example/30' };
      if (commandName === 'herdr' && args[0] === 'worktree') return { result: { worktrees: [] } };
      throw new Error(`unexpected JSON command: ${commandName} ${args.join(' ')}`);
    },
  };
  const original = console.log;
  let output;
  console.log = (value) => { output = JSON.parse(value); };
  try { main(['start', '30', '--dry-run'], runner); } finally { console.log = original; }
  assert.equal(output.topology, 'compact');
  assert.deepEqual(output.panes.workers, ['implementer', 'validator']);
  assert.equal(output.roles.owner.launch, 'herdr');
  assert.ok(Array.isArray(output.observer));
  assert.equal(calls.some(([commandName, args]) => commandName === 'git' && args[0] === 'fetch'), false);
});

test('status reports compact or legacy topology and observer health', () => {
  const worktrees = [
    { branch: 'issue/30-new', path: '/new', open_workspace_id: 'w30' },
    { branch: 'issue/31-old', path: '/old', open_workspace_id: 'w31' },
  ];
  const runner = {
    env: { HERDR_ENV: '1' },
    run(commandName, args) {
      if (commandName === 'git') return { status: 0, stdout: '/repo', stderr: '' };
      if (args[0] === 'pane' && args[1] === 'process-info') return { status: 0, stdout: 'node observe.mjs', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    json(commandName, args) {
      if (commandName === 'herdr' && args[0] === 'worktree') return { result: { worktrees } };
      if (commandName === 'herdr' && args[0] === 'agent') return { result: { agents: [] } };
      if (commandName === 'gh' && args[0] === 'pr') return [];
      const workspace = args[args.indexOf('--workspace') + 1];
      if (commandName === 'herdr' && args[0] === 'tab') return { result: { tabs: workspace === 'w30' ? [{ label: 'overview', tab_id: 'to' }, { label: 'workers', tab_id: 'tw' }] : [{ label: 'owner', tab_id: 'lo' }, { label: 'planner', tab_id: 'lp' }] } };
      if (commandName === 'herdr' && args[0] === 'pane') return { result: { panes: workspace === 'w30' ? [{ label: 'diff', pane_id: 'pd', tab_id: 'to' }] : [] } };
      throw new Error(`unexpected JSON command: ${commandName} ${args.join(' ')}`);
    },
  };
  const original = console.log;
  let output;
  console.log = (value) => { output = JSON.parse(value); };
  try { main(['status'], runner); } finally { console.log = original; }
  assert.deepEqual(output.active.map(({ topology: value, observer }) => [value, observer]), [['compact', 'running'], ['legacy', null]]);
  assert.deepEqual(Object.keys(output.active[0].roles), ['owner', 'implementer', 'validator']);
});

function gitFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'squeeze-observer-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  command(root, ['git', 'init', '-q']);
  command(root, ['git', 'config', 'user.email', 'test@example.com']);
  command(root, ['git', 'config', 'user.name', 'Test']);
  writeFileSync(join(root, 'base.txt'), 'base\n');
  command(root, ['git', 'add', '.']); command(root, ['git', 'commit', '-qm', 'base']);
  command(root, ['git', 'branch', '-M', 'main']);
  command(root, ['git', 'checkout', '-qb', 'issue']);
  return root;
}

test('observer renders committed, staged, unstaged, and eligible untracked changes', (t) => {
  const root = gitFixture(t);
  writeFileSync(join(root, 'committed.txt'), 'committed\n'); command(root, ['git', 'add', '.']); command(root, ['git', 'commit', '-qm', 'feature']);
  writeFileSync(join(root, 'staged.txt'), 'staged\n'); command(root, ['git', 'add', 'staged.txt']);
  writeFileSync(join(root, 'base.txt'), 'unstaged\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.txt\n'); writeFileSync(join(root, 'ignored.txt'), 'ignored\n');
  writeFileSync(join(root, 'untracked.txt'), 'untracked\n'); writeFileSync(join(root, 'binary.bin'), Buffer.from([0, 1, 2]));
  writeFileSync(join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 65));
  const output = renderSnapshot({ worktree: root, issue: '30', branch: 'issue/30-safe', base: 'main' });
  for (const value of ['feature', 'committed.txt', 'staged.txt', 'unstaged', 'untracked.txt', 'binary.bin (binary)', 'large.txt (1048577 bytes, too large to render)']) assert.ok(output.includes(value), value);
  assert.doesNotMatch(output, /\?\? ignored.txt/);
});

test('observer redraws on filesystem and Git changes but skips identical output', async (t) => {
  const root = gitFixture(t);
  const writes = [];
  const close = observe({ worktree: root, issue: '30', branch: 'issue/30-safe', base: 'main' }, { interval: 40, debounce: 10, stream: { write: (value) => writes.push(value) } });
  t.after(close);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(writes.length, 1);
  writeFileSync(join(root, 'base.txt'), 'changed\n');
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(writes.length >= 2);
  const beforeCommit = writes.length;
  command(root, ['git', 'add', 'base.txt']); command(root, ['git', 'commit', '-qm', 'changed head']);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.ok(writes.length > beforeCommit);
});

test('redrawer does not redraw identical content', () => {
  const writes = [];
  const redraw = createRedrawer({ write: (value) => writes.push(value) });
  assert.equal(redraw('same'), true);
  assert.equal(redraw('same'), false);
  assert.equal(redraw('different'), true);
  assert.equal(writes.length, 2);
});

function cleanupRunner({ dirty = false, issueState = 'OPEN', mergedAt = null } = {}) {
  const calls = [];
  return {
    calls, env: { HERDR_ENV: '1' },
    run(commandName, args) {
      calls.push([commandName, args]);
      if (commandName === 'git' && args[0] === 'rev-parse' && args[1] === '--show-toplevel') return { status: 0, stdout: '/repo', stderr: '' };
      if (commandName === 'git' && args[0] === 'status') return { status: 0, stdout: dirty ? ' M file' : '', stderr: '' };
      if (commandName === 'git' && args[0] === 'rev-parse') return { status: 0, stdout: 'origin/issue/30-safe', stderr: '' };
      if (commandName === 'git' && args[0] === 'rev-list') return { status: 0, stdout: '0', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    json(commandName, args) {
      calls.push([commandName, args]);
      if (commandName === 'herdr' && args[0] === 'worktree') return { result: { worktrees: [{ branch: 'issue/30-safe', path: '/worktree', open_workspace_id: 'w30' }] } };
      if (commandName === 'gh' && args[0] === 'issue') return { state: issueState };
      if (commandName === 'gh' && args[0] === 'pr') return [{ state: mergedAt ? 'MERGED' : 'OPEN', mergedAt }];
      throw new Error(`unexpected JSON command: ${commandName} ${args.join(' ')}`);
    },
  };
}

test('cleanup preserves safety checks', () => {
  const dirty = cleanupRunner({ dirty: true });
  assert.throws(() => main(['cleanup', '30'], dirty), /worktree is dirty/);
  const open = cleanupRunner();
  assert.throws(() => main(['cleanup', '30'], open), /issue is open and PR is not merged/);
  assert.equal(open.calls.some(([, args]) => args[1] === 'remove'), false);
});
