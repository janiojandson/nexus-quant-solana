/**
 * In-memory, single-process Jupiter organization scheduler. Its quotas are not
 * shared with other processes. Use one global authority when integrating more
 * than one service. A transport that ignores abort keeps its org unavailable
 * until it settles; callers still receive the deadline error.
 */
export type JupiterWork = 'EXIT' | 'RECONCILE' | 'ENTRY' | 'DISCOVERY';
export type JupiterRole = 'PROTECTION' | 'ENTRY' | 'DISCOVERY';
export interface JupiterCredential { orgId: string; apiKey: string; role: JupiterRole }
export interface JupiterResponse { status: number; headers: { get(name: string): string | null }; body: unknown }
export type JupiterTransport = (credential: JupiterCredential, endpoint: string, payload?: unknown, signal?: AbortSignal) => Promise<JupiterResponse>;
export interface JupiterRuntime { now(): number; sleep(ms: number): Promise<void> }
export interface JupiterRequestOptions { deadlineMs?: number; signal?: AbortSignal }

type Bucket = { times: number[]; remaining?: number; resetAt: number; cooldownUntil: number };
type Org = { credential: JupiterCredential; main: Bucket; execute: Bucket; inflight: boolean };
type Job = {
  work: JupiterWork; endpoint: string; payload: unknown; options: JupiterRequestOptions; bucket: 'main' | 'execute';
  resolve(value: JupiterResponse): void; reject(error: Error): void; cleanup(): void;
};
const priority: JupiterWork[] = ['EXIT', 'RECONCILE', 'ENTRY', 'DISCOVERY'];
const fail = (message: string) => new Error(`JupiterOrgHub: ${message}`);
export class JupiterHubError extends Error {
  constructor(public readonly kind: 'network' | 'auth' | 'http' | 'rate' | 'uncertain' | 'abort', public readonly status?: number) {
    super(`JupiterOrgHub: ${kind === 'uncertain' ? 'execution status unknown; reconcile before any retry' : kind === 'rate' ? 'rate limited (429)' : kind + ' request failure'}`);
  }
}
const bucket = (): Bucket => ({ times: [], resetAt: 0, cooldownUntil: 0 });

function classify(work: JupiterWork, endpoint: string): 'main' | 'execute' {
  const order = endpoint === '/swap/v2/order';
  const execute = endpoint === '/swap/v2/execute';
  const tokens = endpoint === '/tokens/v2/recent' || endpoint === '/tokens/v2/search' ||
    /^\/tokens\/v2\/(toporganicscore|toptraded|toptrending)\/(5m|1h|6h|24h)$/.test(endpoint);
  if (work === 'DISCOVERY' && tokens) return 'main';
  if ((work === 'EXIT' || work === 'ENTRY') && execute) return 'execute';
  if ((work === 'EXIT' || work === 'ENTRY' || work === 'RECONCILE') && order) return 'main';
  throw fail('endpoint is not allowed for this role');
}

function headerNumber(response: JupiterResponse, name: string): number | undefined {
  const raw = response.headers.get(`x-ratelimit-${name}`) ?? response.headers.get(`ratelimit-${name}`);
  if (raw === null || raw.trim() === '') return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export class JupiterOrgHub {
  private readonly orgs: Org[];
  private readonly queues = new Map<JupiterWork, Job[]>(priority.map(p => [p, []]));
  private entryCursor = 0;
  private scheduled = false;
  private wakeAt = Infinity;
  private readonly transport: JupiterTransport;
  private readonly runtime: JupiterRuntime;

  constructor(credentials: JupiterCredential[], transport: JupiterTransport, runtime: JupiterRuntime) {
    if (credentials.length !== 4 || typeof transport !== 'function' || !runtime || typeof runtime.now !== 'function' || typeof runtime.sleep !== 'function')
      throw fail('exactly four credentials, transport and runtime are required');
    const ids = new Set<string>();
    const keys = new Set<string>();
    const roles: Record<JupiterRole, number> = { PROTECTION: 0, ENTRY: 0, DISCOVERY: 0 };
    for (const credential of credentials) {
      if (!credential || typeof credential.orgId !== 'string' || !credential.orgId.trim() ||
        credential.orgId !== credential.orgId.trim() || typeof credential.apiKey !== 'string' ||
        !credential.apiKey.trim() || credential.apiKey !== credential.apiKey.trim() || !(credential.role in roles))
        throw fail('invalid credential');
      if (ids.has(credential.orgId) || keys.has(credential.apiKey)) throw fail('duplicate organization id or api key');
      ids.add(credential.orgId); keys.add(credential.apiKey); roles[credential.role]++;
    }
    if (roles.PROTECTION !== 1 || roles.ENTRY !== 2 || roles.DISCOVERY !== 1) throw fail('invalid organization roles');
    this.transport = transport;
    this.runtime = runtime;
    this.orgs = credentials.map(credential => ({ credential: { ...credential }, main: bucket(), execute: bucket(), inflight: false }));
  }

  /** deadlineMs is an absolute runtime.now() timestamp; omitted means now + 10 seconds. */
  request(work: JupiterWork, endpoint: string, payload?: unknown, options: JupiterRequestOptions = {}): Promise<JupiterResponse> {
    let selected: 'main' | 'execute';
    const effective = { ...options, deadlineMs: options.deadlineMs ?? this.runtime.now() + 10000 };
    try {
      selected = classify(work, endpoint);
      if (!Number.isFinite(effective.deadlineMs)) throw fail('deadline must be finite');
      if (effective.signal?.aborted) throw fail('aborted');
      if (effective.deadlineMs <= this.runtime.now()) throw fail('deadline exceeded');
      if (this.queueSize() >= 256) throw fail('queue full');
    } catch (error) { return Promise.reject(error); }
    return new Promise<JupiterResponse>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let job!: Job;
      const cancel = (reason: string) => {
        const queue = this.queues.get(work)!;
        const index = queue.indexOf(job);
        if (index >= 0) {
          queue.splice(index, 1);
          job.cleanup();
          reject(fail(reason));
          this.schedule();
        }
      };
      const onAbort = () => cancel('aborted');
      job = { work, endpoint, payload, options: effective, bucket: selected, resolve, reject,
        cleanup: () => { if (timer) clearTimeout(timer); effective.signal?.removeEventListener('abort', onAbort); } };
      effective.signal?.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(() => cancel('deadline exceeded'), Math.max(0, effective.deadlineMs - this.runtime.now()));
      this.queues.get(work)!.push(job);
      this.schedule();
    });
  }

  snapshot() {
    const now = this.runtime.now();
    return {
      queue: Object.fromEntries(priority.map(work => [work, this.queues.get(work)!.length])),
      organizations: this.orgs.map(org => {
        this.prune(org.main, now, 60000); this.prune(org.execute, now, 1000);
        return { orgId: org.credential.orgId, role: org.credential.role, mainUsed: org.main.times.length,
          executeUsed: org.execute.times.length,
          mainCooldownUntil: Math.max(org.main.cooldownUntil, org.main.remaining === 0 ? org.main.resetAt : 0),
          executeCooldownUntil: Math.max(org.execute.cooldownUntil, org.execute.remaining === 0 ? org.execute.resetAt : 0) };
      }),
    };
  }

  private queueSize() { return priority.reduce((sum, work) => sum + this.queues.get(work)!.length, 0); }
  private schedule() {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.drain(); });
  }
  private prune(bucket: Bucket, now: number, window: number) {
    while (bucket.times.length && bucket.times[0] <= now - window) bucket.times.shift();
    if (bucket.resetAt && bucket.resetAt <= now) {
      // A remote reset is an opportunity to probe, not proof that the remote
      // quota is now empty. Only a fresh header can establish new capacity.
      if (bucket.remaining !== undefined) bucket.remaining = 1;
      bucket.resetAt = 0;
    }
  }
  private readyAt(org: Org, selected: 'main' | 'execute', now: number): number {
    const b = org[selected], window = selected === 'main' ? 60000 : 1000, limit = selected === 'main' ? 60 : 50;
    this.prune(b, now, window);
    if (org.inflight) return Infinity;
    let at = Math.max(now, b.cooldownUntil);
    if (b.times.length >= limit) at = Math.max(at, b.times[0] + window);
    if (b.remaining !== undefined && b.remaining <= 0) at = Math.max(at, b.resetAt || now + 1000);
    return at;
  }
  private candidates(work: JupiterWork): Org[] {
    if (work === 'ENTRY') {
      const entries = this.orgs.filter(o => o.credential.role === 'ENTRY');
      return [entries[this.entryCursor], entries[1 - this.entryCursor]];
    }
    return this.orgs.filter(o => o.credential.role === (work === 'DISCOVERY' ? 'DISCOVERY' : 'PROTECTION'));
  }
  private drain() {
    const now = this.runtime.now();
    let next = Infinity;
    for (const work of priority) {
      const queue = this.queues.get(work)!;
      for (let i = 0; i < queue.length;) {
        const job = queue[i];
        if (job.options.signal?.aborted || (job.options.deadlineMs !== undefined && job.options.deadlineMs <= now)) {
          queue.splice(i, 1); job.cleanup(); job.reject(fail(job.options.signal?.aborted ? 'aborted' : 'deadline exceeded')); continue;
        }
        const choices = this.candidates(work);
        const ready = choices.find(org => this.readyAt(org, job.bucket, now) <= now);
        if (ready) {
          queue.splice(i, 1); job.cleanup();
          if (work === 'ENTRY') this.entryCursor = 1 - this.orgs.filter(o => o.credential.role === 'ENTRY').indexOf(ready);
          ready.inflight = true;
          const b = ready[job.bucket]; b.times.push(now);
          if (b.remaining !== undefined) {
            b.remaining--;
            if (b.remaining <= 0 && !b.resetAt) b.resetAt = now + (job.bucket === 'main' ? 60000 : 1000);
          }
          void this.run(ready, job);
        } else {
          for (const org of choices) next = Math.min(next, this.readyAt(org, job.bucket, now));
          next = Math.min(next, job.options.deadlineMs ?? Infinity);
          // The head of this work queue owns its place even if a later job
          // targets a different bucket. Other work queues continue below.
          break;
        }
      }
    }
    if (Number.isFinite(next) && next > now && next < this.wakeAt) {
      this.wakeAt = next;
      const wake = () => { this.wakeAt = Infinity; this.schedule(); };
      const afterSleep = () => {
        const remaining = next - this.runtime.now();
        if (remaining > 0) setTimeout(wake, Math.min(remaining, 2147483647));
        else wake();
      };
      void this.runtime.sleep(next - now).then(afterSleep, afterSleep);
    }
  }

  private async run(org: Org, job: Job) {
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    job.options.signal?.addEventListener('abort', onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = job.options.deadlineMs;
    if (deadline !== undefined) timer = setTimeout(() => controller.abort(), Math.max(0, deadline - this.runtime.now()));
    let pending = true;
    let finished = false;
    let released = false;
    const release = () => { if (!released) { released = true; org.inflight = false; this.schedule(); } };
    const operation = Promise.resolve().then(() => {
      if (controller.signal.aborted || (deadline !== undefined && this.runtime.now() >= deadline)) {
        controller.abort();
        throw fail('deadline or abort');
      }
      return this.transport(org.credential, job.endpoint, job.payload, controller.signal);
    });
    void operation.then(() => { pending = false; if (finished) release(); }, () => { pending = false; if (finished) release(); });
    const processed = operation.then(result => {
      this.updateHeaders(org[job.bucket], result, this.runtime.now());
      if (result.status === 429) {
        const reset = headerNumber(result, 'reset');
        const b = org[job.bucket];
        b.cooldownUntil = reset !== undefined && reset * 1000 > this.runtime.now() ? reset * 1000 : this.runtime.now() + 1000;
        b.remaining = 0;
        b.resetAt = b.cooldownUntil;
      }
      return result;
    });
    const onControllerAbort = () => abortReject(fail('deadline or abort'));
    let abortReject!: (error: Error) => void;
    const aborted = new Promise<never>((_, reject) => { abortReject = reject; controller.signal.addEventListener('abort', onControllerAbort, { once: true }); });
    try {
      const result = await Promise.race([processed, aborted]);
      if (job.options.signal?.aborted || (deadline !== undefined && this.runtime.now() >= deadline)) {
        controller.abort();
        throw fail('deadline or abort');
      }
      if (result.status === 429) {
        if (job.bucket === 'execute') throw fail('execution status unknown; reconcile before any retry');
        throw new JupiterHubError('rate', 429);
      }
      if (result.status < 200 || result.status >= 300) throw new JupiterHubError(result.status === 401 || result.status === 403 ? 'auth' : 'http', result.status);
      job.resolve(result);
    } catch (error) {
      job.reject(job.bucket === 'execute' ? new JupiterHubError('uncertain') : controller.signal.aborted ? new JupiterHubError('abort') : error instanceof JupiterHubError ? error : new JupiterHubError('network'));
    } finally {
      if (timer) clearTimeout(timer);
      job.options.signal?.removeEventListener('abort', onAbort);
      controller.signal.removeEventListener('abort', onControllerAbort);
      finished = true;
      if (!pending) release();
    }
  }

  private updateHeaders(b: Bucket, result: JupiterResponse, now: number) {
    const remaining = headerNumber(result, 'remaining');
    const reset = headerNumber(result, 'reset');
    if (remaining !== undefined) {
      b.remaining = Math.max(0, Math.floor(remaining));
      b.resetAt = reset !== undefined && reset * 1000 > now ? reset * 1000 : now + 1000;
    }
  }
}
