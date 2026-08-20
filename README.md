# Squeeze Chute

Squeeze turns GitHub issues into isolated Herdr worktree teams with owner, planner, implementer,
and validator roles.

Every pull request must be reviewed and approved by a human through GitHub before it is merged.

## Requirements

- Git, GitHub CLI, Node.js, and Herdr
- A Herdr-managed terminal (`HERDR_ENV=1`)
- Configured Herdr integrations for every selected agent kind

## Install

Clone the repository and link the bundled skill into your personal skills directory:

```sh
git clone git@github.com:wthorp/squeeze-chute.git ~/Desktop/squeeze-chute
ln -s ~/Desktop/squeeze-chute/skill ~/.agents/skills/squeeze
```

Restart Codex, then use:

```text
$squeeze new "problem description"
$squeeze start 30
$squeeze status
$squeeze cleanup 30
```

## Configuration

Global configuration lives at `~/.config/squeeze/config.json`. A tracked `.squeeze.json` may
partially override it per repository. Repository initialization is an argument array and never
runs through a shell:

```json
{
  "init": ["pnpm", "install", "--frozen-lockfile"]
}
```

An empty `init` array disables initialization. The built-in agent defaults deliberately bypass
Codex approvals/sandboxing and Claude permissions; override role `args` if that is not appropriate
for your environment.

## Test

```sh
node --test skill/scripts/squeeze.test.mjs
```
