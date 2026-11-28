import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { redactSecrets } from './types.js';

export interface StdioRpcOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

export class JsonRpcStdioClient extends EventEmitter {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly rl: readline.Interface;
  private readonly errRl: readline.Interface;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: Error) => void; timer: NodeJS.Timeout }
  >();
  private closed = false;
  private closing = false;
  private stderrTail = '';
  public onRequest?: (method: string, params: Record<string, any>) => Promise<unknown>;

  constructor(options: StdioRpcOptions) {
    super();
    this.child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32'
    });
    this.rl = readline.createInterface({ input: this.child.stdout });
    this.errRl = readline.createInterface({ input: this.child.stderr });

    this.rl.on('line', (line) => this.handleLine(line));
    this.errRl.on('line', (line) => {
      this.stderrTail = (this.stderrTail + '\n' + redactSecrets(line)).slice(-1800);
      this.emit('stderrLine', line);
    });
    this.child.stdin.on('error', (err) => this.failAll(err));
    this.child.on('error', (err) => this.failAll(err));
    this.child.on('exit', (code, sig) => {
      this.failAll(new Error(`Native process exited (${sig || code})${code ? ': ' + this.stderrTail : ''}`));
    });
  }

  private handleLine(line: string): void {
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.emit('nonJsonLine', line);
      return;
    }

    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const entry = this.pending.get(Number(msg.id));
      if (!entry) return;
      this.pending.delete(Number(msg.id));
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(new Error(redactSecrets(msg.error.message || 'JSON-RPC error')));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && typeof msg.method === 'string') {
      const reply = (payload: Record<string, unknown>) => {
        if (!this.closed && !this.closing) {
          this.sendRaw({ jsonrpc: '2.0', id: msg.id, ...payload });
        }
      };
      Promise.resolve()
        .then(() => (this.onRequest ? this.onRequest(msg.method, msg.params ?? {}) : {}))
        .then((result) => reply({ result: result ?? {} }))
        .catch((err) => reply({ error: { code: -32000, message: redactSecrets((err as Error).message) } }));
      return;
    }

    if (typeof msg.method === 'string') {
      this.emit('notification', msg.method, msg.params ?? {});
    }
  }

  public sendRaw(payload: Record<string, unknown>): void {
    if (this.closed || this.closing || this.child.stdin.writableEnded) {
      throw new Error('JSON-RPC stdio connection already closed');
    }
    this.child.stdin.write(JSON.stringify(payload) + '\n');
  }

  public call<T = any>(method: string, params: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<T> {
    if (this.closed) {
      return Promise.reject(new Error('JSON-RPC stdio connection closed'));
    }
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`JSON-RPC timeout calling ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendRaw({ jsonrpc: '2.0', id, method, params });
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err as Error);
      }
    });
  }

  private failAll(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(redactSecrets(err.message)));
    }
    this.pending.clear();
    this.rl.close();
    this.errRl.close();
    this.emit('closed', err);
  }

  public get isClosed(): boolean {
    return this.closed;
  }

  public async stop(): Promise<void> {
    if (this.closed) return;
    this.closing = true;
    const sendSignal = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && this.child.pid) {
          process.kill(-this.child.pid, sig);
        } else {
          this.child.kill(sig);
        }
      } catch {
        // ignore ESRCH
      }
    };
    this.child.stdin.end();
    sendSignal('SIGTERM');
    await Promise.race([
      new Promise<void>((r) => this.child.once('exit', () => r())),
      new Promise<void>((r) => setTimeout(r, 1500))
    ]);
    if (!this.closed) {
      sendSignal('SIGKILL');
    }
    this.failAll(new Error('Stdio client stopped'));
  }
}
