#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { main } from './main.js'

// Piped into `head`, say: the reader has gone, which is not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0)
  throw err
})

// Ctrl-C or a container stop: let a running command finish what it is doing and close.
const stop = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stop.abort())

// One readline interface, made on first use and shared by every prompt in the command.
let lines: ReturnType<typeof createInterface> | undefined;
const prompt = async (question: string): Promise<string | null> => {
  lines ??= createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await lines.question(question);
  } catch {
    return null;
  }
};

process.exitCode = await main(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr,
  env: process.env,
  cwd: process.cwd(),
  signal: stop.signal,
  readStdin: async () => {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return text;
  },
  interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
  prompt,
});
lines?.close();
