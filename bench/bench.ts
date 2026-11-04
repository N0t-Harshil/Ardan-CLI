// Reproducible performance numbers for the README:  npm run bench
//
//   startup      median wall time of `ardan --version`
//   per step     Ardan's own cost for one agent step (model turn -> tool
//                call -> result fed back), measured against an instant
//                local model so model think-time is excluded:
//                (time for N+1 steps - time for 1 step) / N
//   memory       peak resident memory of a 25-step agent run
//
// The "model" is a local OpenAI-compatible server that answers instantly,
// asking for one Read tool call per turn until it has N results.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const root = path.resolve(import.meta.dirname, '..');
const cli = path.join(root, 'bin', 'ardan.js');
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

let targetSteps = 1;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    const done = JSON.parse(body).messages.filter((m: any) => m.role === 'tool').length;
    const delta = done < targetSteps
      ? { tool_calls: [{ index: 0, id: `c${done}`, type: 'function', function: { name: 'Read', arguments: '{"file_path":"notes.txt"}' } }] }
      : { content: 'finished' };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    res.end('data: [DONE]\n\n');
  });
});
await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = (server.address() as AddressInfo).port;

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-bench-'));
fs.writeFileSync(path.join(workdir, 'notes.txt'), 'hello\n'.repeat(200));
const env = {
  ...process.env,
  OPENAI_API_KEY: 'bench',
  OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
  ARDAN_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'ardan-bench-cfg-')),
  ARDAN_DISABLE_CRON: '1',
  ARDAN_MAX_TURNS: '200',
  NO_COLOR: '1',
};
// report the child's peak RSS on exit
const rssHook = `data:text/javascript,process.on('exit',()=>process.stderr.write('RSS_KB='+process.resourceUsage().maxRSS+'\\n'))`;

function run(args: string[], withRss = false): Promise<{ ms: number; rssKb: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(process.execPath, [...(withRss ? ['--import', rssHook] : []), cli, ...args], {
      env, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`exit ${code} for [${args.join(" ")}] rss=${withRss}: ${stderr.slice(-400)}`));
      resolve({ ms: performance.now() - started, rssKb: Number(stderr.match(/RSS_KB=(\d+)/)?.[1] || 0) });
    });
  });
}

const agentRun = (steps: number, withRss = false) => {
  targetSteps = steps;
  return run(['--yes', '--provider', 'openai', '--model', 'bench', '--cwd', workdir, 'read notes.txt'], withRss);
};

await run(['--version']); // warm the compile cache
const startup: number[] = [];
for (let i = 0; i < 9; i++) startup.push((await run(['--version'])).ms);

const N = 25;
const one: number[] = [];
const many: number[] = [];
for (let i = 0; i < 5; i++) {
  one.push((await agentRun(1)).ms);
  many.push((await agentRun(N + 1)).ms);
}
const perStep = (median(many) - median(one)) / N;
const memory = await agentRun(N + 1, true);
server.close();

const cpu = os.cpus()[0]?.model.trim() || 'unknown CPU';
console.log(`Ardan benchmark — Node ${process.versions.node}, ${os.platform()}, ${cpu} (${os.cpus().length} threads)\n`);
console.log(`  startup (ardan --version, median of 9)        ${median(startup).toFixed(0)} ms`);
console.log(`  1-step agent run, end to end (median of 5)    ${median(one).toFixed(0)} ms`);
console.log(`  overhead per agent step (model->tool->model)  ${perStep.toFixed(1)} ms`);
console.log(`  peak memory, ${N + 1}-step agent run               ${(memory.rssKb / 1024).toFixed(0)} MB`);
