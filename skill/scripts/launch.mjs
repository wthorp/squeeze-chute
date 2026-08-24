#!/usr/bin/env node
import { spawn } from 'node:child_process';

let command;
try {
  command = JSON.parse(Buffer.from(process.argv[2] ?? '', 'base64url').toString());
} catch {
  throw new Error('invalid encoded command');
}
if (!Array.isArray(command) || command.length === 0 || !command.every((arg) => typeof arg === 'string' && arg.length > 0)) {
  throw new Error('command must be an array of non-empty strings');
}

const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env: process.env });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
