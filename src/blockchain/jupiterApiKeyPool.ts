/** One shared round-robin cursor for quote, order and execute requests. Never logs keys. */
export class JupiterApiKeyPool {
  private cursor = 0;
  private readonly keys: string[];
  constructor(keys = process.env.JUPITER_API_KEYS, fallback = process.env.JUPITER_API_KEY) {
    this.keys = [...new Set((keys || '').split(',').map(k => k.trim()).filter(Boolean))];
    if (!this.keys.length && fallback?.trim()) this.keys.push(fallback.trim());
  }
  public hasKeys(): boolean { return this.keys.length > 0; }
  public next(): string | undefined {
    if (!this.keys.length) return undefined;
    return this.keys[this.cursor++ % this.keys.length];
  }
}
let shared: JupiterApiKeyPool | undefined;
let sharedSignature: string | undefined;
export function getJupiterApiKeyPool(explicitKey?: string): JupiterApiKeyPool {
  if (explicitKey !== undefined) return new JupiterApiKeyPool('', explicitKey);
  const signature = JSON.stringify([process.env.JUPITER_API_KEYS, process.env.JUPITER_API_KEY]);
  if (!shared || signature !== sharedSignature) {
    shared = new JupiterApiKeyPool(); sharedSignature = signature;
  }
  return shared;
}
