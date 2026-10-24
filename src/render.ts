// Zero-dependency ANSI renderer.
import readline from 'node:readline';
import type { RenderEvent } from './agent.ts';
import type { PermissionAnswer } from './types.ts';
import { parseSingleCall } from './utils/tooljson.ts';

const ENABLE_COLOR =
  process.env.NO_COLOR === undefined && process.env.FORCE_COLOR !== '0';

const BK = String.fromCharCode(96);
const TRI = `${BK}${BK}${BK}`; // the marker a model uses to open/close a fenced block

export const color = (code: string, text: string) =>
  ENABLE_COLOR ? `\x1b[${code}m${text}\x1b[22m` : text;

export const dim = (text: string) => color('2', text);
export const bold = (text: string) => color('1', text);
export const red = (text: string) => color('91', text);
export const green = (text: string) => color('92', text);
export const yellow = (text: string) => color('93', text);
export const cyan = (text: string) => color('96', text);
export const magenta = (text: string) => color('95', text);

export function clearLine(): void {
  if (process.stdout.isTTY) process.stdout.write('\r\x1b[2K');
}

export function printBanner(provider: string, model: string): void {
  const banner = `
 █████╗ ██████╗ ██████╗  █████╗ ███╗   ██╗
██╔══██╗██╔══██╗██╔══██╗██╔══██╗████╗  ██║
███████║██████╔╝██║  ██║███████║██╔██╗ ██║
██╔══██║██╔══██╗██║  ██║██╔══██║██║╚██╗██║
██║  ██║██████╔╝██████╔╝██║  ██║██║ ╚████║
╚═╝  ╚═╝╚═╝  ╚═╝╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═══╝
  open coding agent - any provider`;
  if (process.stdout.isTTY && process.stdout.columns < 60) {
    console.log(magenta('ARDAN'));
  } else {
    console.log(magenta(banner.slice(1)));
  }
  console.log(`\n ● ${green(provider)} ${dim(`(${model})`)}\n`);
  console.log(dim(' Type /help for commands. @file to attach. !cmd to run shell. Ctrl+C to interrupt.'));
}

export interface Renderer {
  startTurn(): void;
  event(event: RenderEvent): void;
  finishTurn(): void;
}

export class LiveRenderer implements Renderer {
  private spinner?: NodeJS.Timeout;
  private frame = 0;
  private waitingLabel = '';
  private showSpinner: boolean;
  private lastOutputWasText = false;
  private readonly print: (line: string) => void;
  private readonly write: (text: string) => void;
  private toolNames = new Set<string>();
  private suppress: { buffer: string } | null = null;
  private wb = ''; // streamed-char window (line assembler)

  constructor(
    print: (line: string) => void = (line) => console.log(line),
    write: (text: string) => void = (text) => process.stdout.write(text),
  ) {
    this.print = print;
    this.write = write;
    this.showSpinner = Boolean(process.stdout.isTTY) && process.env.ARDAN_NO_SPINNER !== '1';
  }

  /** Tool names recognized for text-JSON tool-call suppression. */
  setSuppressedNames(names: string[]): void {
    this.toolNames = new Set(names);
  }

  startTurn(): void {
    this.lastOutputWasText = false;
  }

  /* -------------------------------------------- streamed text filter */

  private displayText(text: string): void {
    this.wb += text;
    this.drain();
  }

  private drain(): void {
    for (;;) {
      const newlineAt = this.wb.indexOf('\n');
      if (newlineAt === -1) break;
      const line = this.wb.slice(0, newlineAt);
      this.wb = this.wb.slice(newlineAt + 1);
      if (this.suppress) {
        if (this.isCloseLine(line)) {
          this.closeSuppress(line);
        } else {
          this.suppress.buffer += `${line}\n`;
        }
        continue;
      }
      if (this.opensSuppress(line)) {
        this.suppress = { buffer: `${line}\n` };
      } else {
        this.write(`${line}\n`);
      }
    }
  }

  private opensSuppress(line: string): boolean {
    const trimmed = line.trimStart();
    return (
      trimmed === `${TRI}json` ||
      trimmed.startsWith(`${TRI}json`) ||
      trimmed.startsWith(`${TRI}tool`) ||
      trimmed.startsWith(`${TRI}{`)
    );
  }

  private isCloseLine(line: string): boolean {
    const trimmed = line.trim();
    return trimmed === TRI || trimmed === `${TRI}/tool${TRI}`;
  }

  private closeSuppress(closeLine: string): void {
    const region = this.suppress;
    if (!region) return;
    this.suppress = null;
    // The buffer holds the opening fence line plus body lines; the close
    // line itself was not appended (we detected it in place).
    const inner = region.buffer.slice(region.buffer.indexOf('\n') + 1);
    const call = parseSingleCall(inner.trim(), this.toolNames);
    if (!call) {
      // Ordinary fenced code (a json example, a real snippet) — show it.
      this.write(`${region.buffer}${closeLine}\n`);
    }
    // Tool call: hidden; the loop emits its own tool trace line.
  }

  finishTurn(): void {
    this.stopSpinner();
    this.flushPending();
    if (this.lastOutputWasText) {
      this.print('');
      this.lastOutputWasText = false;
    }
  }

  private flushPending(): void {
    if (this.suppress) {
      // Turn ended while a fenced block was open — flush it verbatim.
      this.write(this.suppress.buffer);
      this.suppress = null;
      this.lastOutputWasText = true;
    }
    if (this.wb) {
      this.write(this.wb);
      this.wb = '';
      this.lastOutputWasText = true;
    }
  }

  /* -------------------------------------------------------- spinner */

  private startSpinner(label: string): void {
    if (!this.showSpinner) return;
    this.waitingLabel = label;
    if (this.spinner) return;
    const frames = ['·   ', '··  ', '··· ', '  ··', '   ·'];
    this.spinner = setInterval(() => {
      const icon = frames[this.frame++ % frames.length];
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
      process.stdout.write(dim(`${icon}${this.waitingLabel}`));
    }, 180);
  }

  private stopSpinner(): void {
    if (this.spinner) {
      clearInterval(this.spinner);
      this.spinner = undefined;
      process.stdout.clearLine?.(0);
      process.stdout.cursorTo?.(0);
    }
  }

  private ensureFreshLine(): void {
    if (this.lastOutputWasText) {
      this.print('');
      this.lastOutputWasText = false;
    }
  }

  /* ---------------------------------------------------------- events */

  event(event: RenderEvent): void {
    switch (event.type) {
      case 'turn_start': {
        this.stopSpinner();
        this.ensureFreshLine();
        this.startSpinner(' thinking...');
        break;
      }
      case 'text': {
        this.displayText(event.text || '');
        this.lastOutputWasText = true;
        break;
      }
      case 'tool_call': {
        this.stopSpinner();
        this.flushPending();
        this.ensureFreshLine();
        this.print(dim(`  ● ${event.call || event.tool}`));
        this.startSpinner(` ${event.tool} working...`);
        break;
      }
      case 'tool_result': {
        this.stopSpinner();
        this.ensureFreshLine();
        const mark = event.ok ? green('⎿ ok') : red('⎿ err');
        this.print(`    ${mark} ${dim(event.result || '')}`);
        this.startSpinner(' continuing...');
        break;
      }
      case 'status': {
        this.stopSpinner();
        this.ensureFreshLine();
        break;
      }
      case 'turn_end': {
        this.stopSpinner();
        this.flushPending();
        this.ensureFreshLine();
        break;
      }
      case 'error': {
        this.stopSpinner();
        this.ensureFreshLine();
        this.print(red(`  ✖ ${event.text}`));
        break;
      }
    }
  }
}

/* -------------------------------------------------- permission prompt */

export async function askPermission(
  tool: string,
  call: string,
  isWrite: boolean,
): Promise<PermissionAnswer> {
  clearLine();
  process.stdout.write(
    yellow(`  ? ${bold(tool)} ${dim(call)}\n    allow? [y] once  [a] this session  [n] no `),
  );
  const answer = await readAnswer();
  return answer === 'a'
    ? 'always'
    : answer === 'y'
      ? 'allow'
      : 'deny';
}

function readAnswer(): Promise<string> {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      process.stdout.write(dim('(non-tty: denying) '));
      resolve('n');
      return;
    }
    process.stdin.setEncoding('utf8');
    const onLine = (chunk: string) => {
      cleanup();
      resolve(chunk.trim().toLowerCase());
    };
    const cleanup = () => {
      process.stdin.off('data', onLine);
      process.stdin.pause();
    };
    process.stdin.once('data', onLine);
    process.stdin.resume();
  });
}

/** One-shot prompt on a fresh readline interface (question tools). */
export async function readUserLine(prompt: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => resolve(answer));
    });
  } finally {
    rl.close();
  }
}
