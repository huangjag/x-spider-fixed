import { Child, Command } from '@tauri-apps/api/shell';
import { EventEmitter } from './event';
import { delay } from './index';
import * as R from 'ramda';

export enum AriaStatus {
  Waiting = 'waiting',
  Active = 'active',
  Paused = 'paused',
  Error = 'error',
  Complete = 'complete',
  Removed = 'removed',
}

export type AriaResult = any;
export interface AriaTask {
  gid: AriaGid;
  status: AriaStatus;
  [key: string]: any;
}

export type AriaGid = string;

const START_PORTS = [6801, 8000];
const PORTS_PER_RANGE = 10;
const LISTEN_TIMEOUT = 10_000;
const WS_TIMEOUT = 5_000;
const RETRY_GAP = 300;
const TOTAL_DEADLINE = 60_000;

const PORT_CANDIDATES = START_PORTS.flatMap((start) =>
  Array.from({ length: PORTS_PER_RANGE }, (_, i) => start + i),
);
const PORT_RANGE_DESC = START_PORTS.map(
  (start) => `${start}-${start + PORTS_PER_RANGE - 1}`,
).join('、');

class Aria2 {
  #ready = false;
  get ready() {
    return this.#ready;
  }
  #secret = crypto.randomUUID();
  #port = START_PORTS[0];
  #bound = false;
  #ws?: WebSocket;
  #command?: Command;
  #child?: Child;
  #invokeId = 0;
  #globalOptions: Record<string, string> = {};
  #callbackMap = new Map<number, (data: any) => void>();

  get #tokenParam() {
    return `token:${this.#secret}`;
  }

  #onBeforeUnload = this.#_onBeforeUnload.bind(this);
  #onStderr = this.#_onStderr.bind(this);
  #onWsMessage = this.#_onWsMessage.bind(this);

  onReady = new EventEmitter();
  onDownloadStart = new EventEmitter<string>();
  onDownloadPause = new EventEmitter<string>();
  onDownloadStop = new EventEmitter<string>();
  onDownloadComplete = new EventEmitter<string>();
  onDownloadError = new EventEmitter<string>();
  #log?: ICategoriedLogger;

  async bootstrap() {
    if (this.#ready) throw new Error('Aria2 is already ready');

    this.#log = log.category('ARIA');

    if (!this.#bound) {
      this.#bound = true;
      window.addEventListener('beforeunload', this.#onBeforeUnload);
    }

    const deadline = Date.now() + TOTAL_DEADLINE;
    let lastError = '';
    let deadlineExceeded = false;

    for (const port of PORT_CANDIDATES) {
      if (Date.now() >= deadline) {
        deadlineExceeded = true;
        break;
      }
      this.#port = port;
      try {
        await this.#startOnce();
        this.#command!.stderr.on('data', this.#onStderr);
        this.#ws!.addEventListener('message', this.#onWsMessage);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.#log?.warn(`Bootstrap failed on port ${port}:`, lastError);
        await this.#cleanup();
        await delay(RETRY_GAP);
      }
    }

    throw new Error(
      deadlineExceeded
        ? `Aria2 启动失败：超过 ${TOTAL_DEADLINE / 1000}s 总时限。最后错误：${lastError}`
        : `Aria2 启动失败：端口 ${PORT_RANGE_DESC} 均不可用。最后错误：${lastError}`,
    );
  }

  async #startOnce() {
    const args = [
      '--enable-rpc',
      '--rpc-secret',
      this.#secret,
      '--rpc-listen-port',
      this.#port.toString(),
    ];
    this.#command = Command.sidecar('binaries/aria2c', args);
    this.#log?.info('Spawn with args:', args);
    this.#child = await this.#command.spawn();
    this.#log?.info('Wait for listening...');
    await this.#waitListening();
    this.#log?.info('Connecting websocket...');
    await this.#connectWs();
    this.#ready = true;
  }

  #waitListening() {
    const command = this.#command!;
    const port = this.#port;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        command.stdout.removeListener('data', onStdout);
        command.stderr.removeListener('data', onStderr);
        command.removeListener('close', onClose);
        command.removeListener('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onStdout = (message: string) => {
        if (message.includes('IPv4 RPC: listening on TCP port')) {
          this.#log?.info(`Aria2 listening on port ${port}`);
          finish();
        } else if (
          message.includes('[ERROR]') ||
          message.includes('failed to bind') ||
          message.includes('Failed to setup RPC server')
        ) {
          finish(new Error(`Aria2 端口 ${port} 启动失败：${message}`));
        }
      };
      const onStderr = (message: string) => {
        finish(new Error(`Aria2 端口 ${port} stderr：${message}`));
      };
      const onClose = (payload: { code?: number | null }) => {
        finish(
          new Error(`Aria2 进程提前退出（code=${payload.code}），端口 ${port}`),
        );
      };
      const onError = (err: string) => {
        finish(new Error(`Aria2 进程错误，端口 ${port}：${err}`));
      };
      const timer = setTimeout(() => {
        finish(
          new Error(
            `等待 Aria2 监听超时（${LISTEN_TIMEOUT / 1000}s），端口 ${port}`,
          ),
        );
      }, LISTEN_TIMEOUT);

      command.stdout.on('data', onStdout);
      command.stderr.on('data', onStderr);
      command.on('close', onClose);
      command.on('error', onError);
    });
  }

  #connectWs() {
    const port = this.#port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/jsonrpc`);
    this.#ws = ws;
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        if (err) reject(err);
        else resolve();
      };
      const onOpen = () => {
        this.#log?.info('Websocket connected');
        finish();
      };
      const onError = () => {
        finish(new Error(`连接 Aria2 WebSocket 失败，端口 ${port}`));
      };
      const timer = setTimeout(() => {
        finish(
          new Error(
            `连接 Aria2 WebSocket 超时（${WS_TIMEOUT / 1000}s），端口 ${port}`,
          ),
        );
      }, WS_TIMEOUT);

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
    });
  }

  async #cleanup() {
    try {
      this.#ws?.close();
    } catch (err) {
      this.#log?.warn('Cleanup: close websocket failed:', err);
    }
    try {
      await this.#child?.kill();
    } catch (err) {
      this.#log?.warn('Cleanup: kill child failed:', err);
    }
    this.#ws = undefined;
    this.#child = undefined;
    this.#command = undefined;
  }

  #_onBeforeUnload() {
    this.#log?.info('Window before unload');
    this.#ws?.close();
    this.#child?.kill().catch((err) => {
      this.#log?.warn('Beforeunload: kill child failed:', err);
    });
  }

  #_onStderr(message: string) {
    this.#log?.error('Stderr', message);
  }

  async #_onWsMessage(ev: MessageEvent) {
    let data: any;

    try {
      data = JSON.parse(ev.data);
    } catch (err) {
      this.#log?.error('Parse json error:', ev.data, err);
      return;
    }

    this.#log?.info('Ws received:', data);

    if (data.id) {
      const id = Number(data.id);
      const fn = this.#callbackMap.get(id);
      if (fn) {
        fn(data);
        this.#callbackMap.delete(id);
      } else {
        this.#log?.warn(`Callback ${id} is not exists`);
      }
    } else if (data.method) {
      // Event
      const gid: string = data.params[0].gid;
      await this.#onAriaEvent(data.method, gid);
    } else {
      this.#log?.warn('Unknown message:', ev.data);
    }
  }

  async #onAriaEvent(method: string, gid: string) {
    this.#log?.info(`Received event method=${method} gid=${gid}`);
    switch (method) {
      case 'aria2.onDownloadStart':
        this.onDownloadStart.emit(gid);
        break;
      case 'aria2.onDownloadPause':
        this.onDownloadPause.emit(gid);
        break;
      case 'aria2.onDownloadStop':
        this.onDownloadStop.emit(gid);
        break;
      case 'aria2.onDownloadComplete':
        this.onDownloadComplete.emit(gid);
        break;
      case 'aria2.onDownloadError':
        this.onDownloadError.emit(gid);
        break;
      default:
        this.#log?.warn('Unknown event:', method);
        break;
    }
  }

  async #updateGlobalOptions(options: Record<string, string>) {
    this.#globalOptions = options;
    this.#log?.info('Update global options:', this.#globalOptions);
    await this.invoke('aria2.changeGlobalOption', this.#globalOptions);
  }

  ensureReady() {
    if (!this.ready) throw new Error('Aria2 is not ready yet');
  }

  async updateProxy(proxyUrl: string) {
    this.#log?.info('Update proxy url:', proxyUrl);
    await this.#updateGlobalOptions({
      ...this.#globalOptions,
      'all-proxy': proxyUrl,
    });
  }

  async #invoke(
    method: string,
    params: any[],
  ): Promise<AriaResult | AriaResult[]> {
    this.ensureReady();
    return new Promise((resolve, reject) => {
      const id = this.#invokeId++;
      const payload = {
        jsonrpc: '2.0',
        id: id.toString(),
        method,
        params,
      };
      this.#log?.info(`Call ${method} id=${id}`, payload);
      this.#ws!.send(JSON.stringify(payload));

      this.#callbackMap.set(id, (data: any) => {
        if (data.error) {
          const err = new Error(
            `Aria2 调用 ${method} 失败：${data.error.message}`,
          );
          this.#log?.error(
            `Return ${method} id=${id} error=`,
            data.error,
            'params=',
            params,
          );
          reject(err);
          return;
        }
        this.#log?.info(`Return ${method} id=${id}`, data.result);
        resolve(data.result);
      });
    });
  }

  async invoke(method: string, ...args: any[]): Promise<AriaResult> {
    return this.#invoke(method, [this.#tokenParam, ...args]);
  }

  async batchInvoke(
    payload: { methodName: string; params: any[] }[],
  ): Promise<AriaResult[]> {
    return (await this.#invoke('system.multicall', [
      payload.map((item) => ({
        methodName: item.methodName,
        params: [this.#tokenParam, ...item.params],
      })),
    ])) as AriaResult[];
  }

  async tellStatus(gid: AriaGid): Promise<AriaTask>;
  async tellStatus(gid: AriaGid[]): Promise<Record<AriaGid, AriaTask>>;
  async tellStatus(gid: AriaGid | AriaGid[]) {
    if (!Array.isArray(gid)) return this.invoke('aria2.tellStatus', gid);

    const results = await aria2.batchInvoke(
      gid.map((id) => ({
        methodName: 'aria2.tellStatus',
        params: [id],
      })),
    );

    const resultMap = R.pipe(
      R.flatten,
      R.map<any, [string, any]>((r: AriaTask) => [r.gid, r]),
      R.fromPairs,
    )(results);

    return resultMap;
  }
}

export const aria2 = new Aria2();
