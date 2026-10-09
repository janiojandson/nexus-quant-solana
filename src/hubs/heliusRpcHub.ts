/** Single-process, in-memory RPC quota coordinator. */
export type RpcWork = 'CRITICAL' | 'STATE';
export interface HeliusKey { id: string; apiKey: string; quotaGroupId: string; role: RpcWork; rps: number }
export interface HeliusQuotaGroup { id: string; rps: number }
export interface RpcResponse { status: number; headers: { get(name: string): string | null }; body: unknown }
export type RpcTransport = (key: HeliusKey, method: string, params: unknown[], signal: AbortSignal) => Promise<RpcResponse>;
export interface RpcRuntime { now(): number; sleep(ms: number): Promise<void>; random(): number }
export interface RpcCallOptions { deadlineMs?: number; signal?: AbortSignal | undefined; bypassCache?: boolean }
export interface RpcHubOptions { cacheTtlMs?: number; allowedRoles?: readonly RpcWork[] }

type KeyState = { credential: HeliusKey; times: number[]; cooldownUntil: number; disabled: boolean; inflight: boolean };
type GroupState = { id: string; rps: number; times: number[]; sends: number[]; disabled: boolean };
type Job = { work: RpcWork; method: string; params: unknown[]; deadline: number; signal?: AbortSignal | undefined;
  resolve(value: unknown): void; reject(error: Fault): void; cleanup(): void; settled: boolean };
type FaultKind = 'rate' | 'transient' | 'invalid' | 'auth' | 'monthly' | 'deadline' | 'abort';
type Fault = Error & { kind: FaultKind };
const internalFaults = new WeakSet<object>();
const fault = (kind: FaultKind, message: string): Fault => {
  const error = Object.assign(new Error(`HeliusRpcHub: ${message}`), { kind });
  internalFaults.add(error);
  return error;
};
const isFault = (value: unknown): value is Fault => typeof value === 'object' && value !== null && internalFaults.has(value);
const common = new Set(['getAccountInfo', 'getMultipleAccounts', 'getBlockTime', 'getTokenSupply', 'getTokenLargestAccounts', 'getBalance', 'getTokenAccountsByOwner', 'getRecentPrioritizationFees', 'getMinimumBalanceForRentExemption']);
export const criticalRpcMethods = new Set(['getLatestBlockhash', 'simulateTransaction', 'getSignatureStatuses', 'getTransaction', 'getSignaturesForAddress', 'getBlockHeight', 'sendTransaction']);
const cacheable = new Set(['getAccountInfo', 'getMultipleAccounts', 'getTokenSupply']);
function knownCacheResult(method: string, result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result !== 'object') return method !== 'getMultipleAccounts';
  const value = (result as Record<string, unknown>).value;
  if (method === 'getAccountInfo' && value === null) return false;
  if (method === 'getMultipleAccounts' && (!Array.isArray(value) || value.includes(null))) return false;
  return true;
}
const validName = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.trim() === value;
const validRate = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const prune = (times: number[], now: number) => { while (times.length && times[0]! <= now - 1000) times.shift(); };
function clone<T>(value: T): T {
  try { return JSON.parse(JSON.stringify(value)) as T; }
  catch { throw fault('transient', 'non-JSON provider result'); }
}

function canonical(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw fault('invalid', 'params must be JSON values');
  if (seen.has(value)) throw fault('invalid', 'cyclic params');
  seen.add(value);
  let out: string;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) if (!Object.prototype.hasOwnProperty.call(value, i)) throw fault('invalid', 'sparse array is not JSON');
    out = `[${value.map(item => canonical(item, seen)).join(',')}]`;
  }
  else {
    if (Object.getPrototypeOf(value) !== Object.prototype) throw fault('invalid', 'params must be plain JSON objects');
    out = `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key], seen)}`).join(',')}}`;
  }
  seen.delete(value);
  return out;
}

function retryAfter(response: RpcResponse, now: number): number | undefined {
  const raw = response.headers.get('retry-after');
  if (raw === null || raw.trim() === '') return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return now + seconds * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(now, date) : undefined;
}

export class HeliusRpcHub {
  private readonly keys: KeyState[];
  private readonly groups: Map<string, GroupState>;
  private readonly queues: Record<RpcWork, Job[]> = { CRITICAL: [], STATE: [] };
  private readonly cursor: Record<RpcWork, number> = { CRITICAL: 0, STATE: 0 };
  private readonly cache = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly coalesced = new Map<string, Promise<unknown>>();
  private readonly cacheTtlMs: number;
  private readonly transport: RpcTransport;
  private readonly runtime: RpcRuntime;
  private scheduled = false;
  private wakeAt = Infinity;
  private readonly allowedRoles: readonly RpcWork[];

  constructor(keys: HeliusKey[], groups: HeliusQuotaGroup[], transport: RpcTransport,
    runtime: RpcRuntime, options: RpcHubOptions = {}) {
    if (!Array.isArray(keys) || !Array.isArray(groups) || typeof transport !== 'function' ||
      !runtime || typeof runtime.now !== 'function' || typeof runtime.sleep !== 'function' || typeof runtime.random !== 'function')
      throw fault('invalid', 'keys, groups, transport and runtime are required');
    this.cacheTtlMs = options.cacheTtlMs ?? 3000;
    this.transport = transport;
    this.runtime = runtime;
    this.allowedRoles = options.allowedRoles ?? ['CRITICAL', 'STATE'];
    if (!this.allowedRoles.length || this.allowedRoles.some(role => role !== 'CRITICAL' && role !== 'STATE')) throw fault('invalid', 'invalid allowed roles');
    if (!Number.isFinite(this.cacheTtlMs) || this.cacheTtlMs < 2000 || this.cacheTtlMs > 5000)
      throw fault('invalid', 'cache TTL must be 2000–5000 ms');
    const groupIds = new Set<string>();
    this.groups = new Map(groups.map(group => {
      if (!group || !validName(group.id) || !validRate(group.rps) || group.rps > 10 || groupIds.has(group.id))
        throw fault('invalid', 'invalid or duplicate quota group');
      groupIds.add(group.id);
      return [group.id, { id: group.id, rps: group.rps, times: [], sends: [], disabled: false }];
    }));
    const ids = new Set<string>(), apiKeys = new Set<string>();
    const roles = { CRITICAL: 0, STATE: 0 };
    this.keys = keys.map(key => {
      if (!key || !validName(key.id) || !validName(key.apiKey) || !validName(key.quotaGroupId) ||
        !this.groups.has(key.quotaGroupId) || !this.allowedRoles.includes(key.role) || !validRate(key.rps) || key.rps > 10 ||
        ids.has(key.id) || apiKeys.has(key.apiKey)) throw fault('invalid', 'invalid or duplicate credential');
      ids.add(key.id); apiKeys.add(key.apiKey); roles[key.role]++;
      return { credential: { ...key }, times: [], cooldownUntil: 0, disabled: false, inflight: false };
    });
    if (this.allowedRoles.some(role => !roles[role])) throw fault('invalid', 'at least one key per allowed role is required');
  }

  /** deadlineMs is an absolute runtime.now() timestamp; omitted means now + 10 seconds. */
  call(work: RpcWork, method: string, params: unknown[], options: RpcCallOptions = {}): Promise<unknown> {
    try {
      if (!this.allowedRoles.includes(work) ||
        !(common.has(method) || (work === 'CRITICAL' && criticalRpcMethods.has(method))))
        throw fault('invalid', 'method is not allowed for role');
      if (!Array.isArray(params)) throw fault('invalid', 'params must be an array');
      const normalizedParams = JSON.parse(canonical(params)) as unknown[];
      const deadline = options.deadlineMs ?? this.runtime.now() + 10000;
      if (!Number.isFinite(deadline)) throw fault('invalid', 'deadline must be finite');
      this.ensureLive(deadline, options.signal);
      const eligible = work === 'STATE' && cacheable.has(method) && !options.bypassCache;
      const cacheKey = eligible ? `${method}:${canonical(normalizedParams)}` : undefined;
      if (cacheKey !== undefined) {
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > this.runtime.now()) return Promise.resolve(clone(cached.value));
        if (cached) this.cache.delete(cacheKey);
        let shared = this.coalesced.get(cacheKey);
        if (!shared) {
          // A physical request is independent of every waiter's cancellation.
          shared = this.perform(work, method, normalizedParams, Math.max(deadline, this.runtime.now() + 10000)).then(value => {
            if (knownCacheResult(method, value)) {
              if (this.cache.size >= 256) this.cache.delete(this.cache.keys().next().value!);
              this.cache.set(cacheKey, { value: clone(value), expiresAt: this.runtime.now() + this.cacheTtlMs });
            }
            return value;
          });
          this.coalesced.set(cacheKey, shared);
          void shared.finally(() => { if (this.coalesced.get(cacheKey) === shared) this.coalesced.delete(cacheKey); }).catch(() => {});
        }
        return this.waiter(shared, deadline, options.signal).then(clone);
      }
      return this.perform(work, method, normalizedParams, deadline, options.signal);
    } catch (error) { return Promise.reject(isFault(error) ? error : fault('invalid', 'invalid params or options')); }
  }

  snapshot() {
    const now = this.runtime.now();
    for (const key of this.keys) prune(key.times, now);
    for (const group of this.groups.values()) { prune(group.times, now); prune(group.sends, now); }
    return { queue: { CRITICAL: this.queues.CRITICAL.length, STATE: this.queues.STATE.length },
      keys: { total: this.keys.length, disabled: this.keys.filter(key => key.disabled).length,
        inflight: this.keys.filter(key => key.inflight).length,
        used: this.keys.reduce((sum, key) => sum + key.times.length, 0) },
      groups: { total: this.groups.size, disabled: [...this.groups.values()].filter(group => group.disabled).length,
        used: [...this.groups.values()].reduce((sum, group) => sum + group.times.length, 0),
        sendUsed: [...this.groups.values()].reduce((sum, group) => sum + group.sends.length, 0) },
      cacheEntries: this.cache.size };
  }

  private async perform(work: RpcWork, method: string, params: unknown[], deadline: number, signal?: AbortSignal): Promise<unknown> {
    const send = method === 'sendTransaction';
    for (let attempt = 1; attempt <= (send ? 1 : 3); attempt++) {
      this.ensureLive(deadline, signal);
      try { return await this.enqueue(work, method, params, deadline, signal); }
      catch (error) {
        const issue = isFault(error) ? error : fault('transient', 'request failed');
        if (send) throw fault('transient', 'transmission status unknown; reconcile before any retry');
        if (issue.kind === 'abort' || issue.kind === 'deadline' || issue.kind === 'invalid' ||
          issue.kind === 'auth' || issue.kind === 'monthly' || attempt === 3) throw issue;
        const jitter = 0.75 + Math.min(1, Math.max(0, this.runtime.random())) * 0.5;
        const delay = Math.min(30000, 1000 * 2 ** (attempt - 1)) * jitter;
        await this.waiter(this.runtime.sleep(delay), deadline, signal);
      }
    }
    throw fault('transient', 'request failed');
  }

  private ensureLive(deadline: number, signal?: AbortSignal) {
    if (signal?.aborted) throw fault('abort', 'aborted');
    if (this.runtime.now() >= deadline) throw fault('deadline', 'deadline exceeded');
  }

  private enqueue(work: RpcWork, method: string, params: unknown[], deadline: number, signal?: AbortSignal): Promise<unknown> {
    if (this.queues.CRITICAL.length + this.queues.STATE.length >= 256)
      return Promise.reject(fault('transient', 'queue full'));
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let job!: Job;
      const cancel = (kind: 'abort' | 'deadline') => {
        if (job.settled) return;
        const queue = this.queues[work];
        const index = queue.indexOf(job);
        if (index >= 0) { queue.splice(index, 1); job.settled = true; job.cleanup(); reject(fault(kind, kind === 'abort' ? 'aborted' : 'deadline exceeded')); this.schedule(); }
      };
      const onAbort = () => cancel('abort');
      job = { work, method, params, deadline, signal, resolve, reject, settled: false,
        cleanup: () => { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', onAbort); } };
      signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => cancel('deadline'), Math.max(0, deadline - this.runtime.now()));
      this.queues[work].push(job);
      this.schedule();
    });
  }

  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }

  private readyAt(key: KeyState, method: string, now: number): number {
    const group = this.groups.get(key.credential.quotaGroupId)!;
    if (key.disabled || group.disabled || key.inflight) return Infinity;
    prune(key.times, now); prune(group.times, now); prune(group.sends, now);
    let at = Math.max(now, key.cooldownUntil);
    if (key.times.length >= key.credential.rps) at = Math.max(at, key.times[0]! + 1000);
    if (group.times.length >= group.rps) at = Math.max(at, group.times[0]! + 1000);
    if (method === 'sendTransaction' && group.sends.length >= 1) at = Math.max(at, group.sends[0]! + 1000);
    return at;
  }

  private drain() {
    const now = this.runtime.now();
    let next = Infinity;
    for (const role of ['CRITICAL', 'STATE'] as const) {
      const queue = this.queues[role];
      while (queue.length) {
        const job = queue[0]!;
        if (job.signal?.aborted || job.deadline <= now) {
          queue.shift(); job.settled = true; job.cleanup(); job.reject(fault(job.signal?.aborted ? 'abort' : 'deadline', job.signal?.aborted ? 'aborted' : 'deadline exceeded')); continue;
        }
        const candidates = this.keys.filter(key => key.credential.role === role);
        if (candidates.every(key => key.disabled || this.groups.get(key.credential.quotaGroupId)!.disabled)) {
          queue.shift(); job.settled = true; job.cleanup(); job.reject(fault('monthly', 'all role quota groups or keys disabled')); continue;
        }
        const start = this.cursor[role] % candidates.length;
        const ordered = [...candidates.slice(start), ...candidates.slice(0, start)];
        const key = ordered.find(candidate => this.readyAt(candidate, job.method, now) <= now);
        if (!key) {
          for (const candidate of ordered) next = Math.min(next, this.readyAt(candidate, job.method, now));
          next = Math.min(next, job.deadline);
          break; // Strict FIFO within role, including method-specific limits.
        }
        queue.shift(); job.cleanup();
        this.cursor[role] = (candidates.indexOf(key) + 1) % candidates.length;
        const group = this.groups.get(key.credential.quotaGroupId)!;
        key.times.push(now); group.times.push(now);
        if (job.method === 'sendTransaction') group.sends.push(now);
        key.inflight = true;
        void this.run(key, job);
      }
    }
    if (Number.isFinite(next) && next < this.wakeAt) {
      this.wakeAt = next;
      void this.runtime.sleep(Math.max(0, next - now)).then(() => {
        if (this.wakeAt !== next) return;
        this.wakeAt = Infinity;
        const remaining = next - this.runtime.now();
        if (remaining > 0) setTimeout(() => this.schedule(), Math.min(remaining, 2147483647));
        else this.schedule();
      }, () => { if (this.wakeAt === next) { this.wakeAt = Infinity; this.schedule(); } });
    }
  }

  private async run(key: KeyState, job: Job) {
    const controller = new AbortController();
    const abort = () => controller.abort();
    job.signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, Math.max(0, job.deadline - this.runtime.now()));
    let pending = true, done = false;
    const release = () => { key.inflight = false; this.schedule(); };
    const transport = Promise.resolve().then(() => {
      this.ensureLive(job.deadline, job.signal);
      if (controller.signal.aborted) throw fault('deadline', 'deadline exceeded');
      return this.transport(key.credential, job.method, job.params, controller.signal);
    });
    void transport.then(() => { pending = false; if (done) release(); }, () => { pending = false; if (done) release(); });
    let removeAbort!: () => void;
    const cancelled = new Promise<never>((_, reject) => {
      const listener = () => reject(fault(job.signal?.aborted ? 'abort' : 'deadline', job.signal?.aborted ? 'aborted' : 'deadline exceeded'));
      controller.signal.addEventListener('abort', listener, { once: true });
      removeAbort = () => controller.signal.removeEventListener('abort', listener);
    });
    try {
      const response = await Promise.race([transport, cancelled]);
      this.ensureLive(job.deadline, job.signal);
      const value = this.parse(response, key);
      this.ensureLive(job.deadline, job.signal);
      job.settled = true; job.resolve(value);
    } catch (error) {
      const issue = isFault(error) ? error : fault('transient', 'transport or response failed');
      job.settled = true;
      job.reject(issue);
    } finally {
      done = true;
      clearTimeout(timer); removeAbort(); job.signal?.removeEventListener('abort', abort);
      if (!pending) release(); // Ignored abort keeps key occupied until transport settles.
    }
  }

  private parse(response: RpcResponse, key: KeyState): unknown {
    if (!response || typeof response.status !== 'number')
      throw fault('transient', 'malformed provider response');
    if (response.status === 401 || response.status === 403) {
      key.disabled = true;
      throw fault('auth', 'credential disabled by provider');
    }
    let body: Record<string, unknown> | undefined;
    let rpcError: Record<string, unknown> | undefined;
    let message = typeof response.body === 'string' ? response.body.toLowerCase() : '';
    try {
      if (response.body && typeof response.body === 'object') body = response.body as Record<string, unknown>;
      if (body?.error && typeof body.error === 'object') rpcError = body.error as Record<string, unknown>;
      if (typeof rpcError?.message === 'string') message = rpcError.message.toLowerCase();
    } catch {
      if (response.status !== 429) throw fault('transient', 'malformed provider response');
    }
    if (/max usage reached|credits? exhausted/.test(message)) {
      this.groups.get(key.credential.quotaGroupId)!.disabled = true;
      throw fault('monthly', 'monthly quota group exhausted');
    }
    if (response.status === 429) {
      const now = this.runtime.now();
      let cooldown = now + 1000;
      try { cooldown = retryAfter(response, now) ?? cooldown; } catch { /* Invalid headers use local cooldown. */ }
      key.cooldownUntil = Math.max(key.cooldownUntil, cooldown);
      throw fault('rate', 'provider rate limited (429)');
    }
    if (response.status < 200 || response.status >= 300) throw fault('transient', 'provider request failed');
    if (!body) throw fault('transient', 'malformed provider response');
    if (body.jsonrpc !== '2.0') throw fault('transient', 'malformed JSON-RPC response');
    if (rpcError) {
      if (rpcError.code === -32600 || rpcError.code === -32601 || rpcError.code === -32602)
        throw fault('invalid', 'invalid JSON-RPC request or params');
      throw fault('transient', 'JSON-RPC provider error');
    }
    if (!Object.prototype.hasOwnProperty.call(body, 'result')) throw fault('transient', 'missing JSON-RPC result');
    if (body.result === undefined) throw fault('transient', 'undefined JSON-RPC result');
    try { canonical(body.result); }
    catch { throw fault('transient', 'non-JSON provider result'); }
    return body.result;
  }

  private waiter<T>(promise: Promise<T>, deadline: number, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) { reject(fault('abort', 'aborted')); return; }
      if (deadline <= this.runtime.now()) { reject(fault('deadline', 'deadline exceeded')); return; }
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); action();
      };
      const onAbort = () => finish(() => reject(fault('abort', 'aborted')));
      const timer = setTimeout(() => finish(() => reject(fault('deadline', 'deadline exceeded'))), Math.max(0, deadline - this.runtime.now()));
      signal?.addEventListener('abort', onAbort, { once: true });
      promise.then(value => finish(() => {
        if (signal?.aborted) reject(fault('abort', 'aborted'));
        else if (deadline <= this.runtime.now()) reject(fault('deadline', 'deadline exceeded'));
        else resolve(value);
      }), error => finish(() => reject(isFault(error) ? error : fault('transient', 'wait failed'))));
    });
  }
}
