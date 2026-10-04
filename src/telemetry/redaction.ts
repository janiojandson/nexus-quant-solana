/**
 * Nexus Quant Solana — V2.0 Telemetry Redaction
 * Ensures zero secrets (private keys, seeds, API keys, bearer tokens, signed payloads)
 * leak into persistent telemetry, logs or metrics.
 */

const SECRET_KEY_NAMES = new Set([
  'privatekey',
  'private_key',
  'secretkey',
  'secret_key',
  'seed',
  'mnemonic',
  'apikey',
  'api_key',
  'authorization',
  'x-api-key',
  'jup_api_key',
  'token',
  'jwt',
  'password'
]);

// URL sensitive query parameters to sanitize
const SENSITIVE_QUERY_PARAMS = ['api-key', 'apikey', 'api_key', 'token', 'secret', 'key'];

/**
 * Sanitizes URLs to mask secret query parameter values.
 * Example: https://mainnet.helius-rpc.com/?api-key=abcdef -> https://mainnet.helius-rpc.com/?api-key=[REDACTED]
 */
export function sanitizeUrl(urlStr: string): string {
  try {
    const parsed = new URL(urlStr);
    let mutated = false;
    for (const param of SENSITIVE_QUERY_PARAMS) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, '[REDACTED]');
        mutated = true;
      }
    }
    if (!mutated) return urlStr;
    return parsed.toString().replace(/%5BREDACTED%5D/gi, '[REDACTED]');
  } catch {
    // Fallback regex for non-standard or partial URLs
    let sanitized = urlStr;
    for (const param of SENSITIVE_QUERY_PARAMS) {
      const reg = new RegExp(`([?&]${param}=)[^&#]+`, 'gi');
      sanitized = sanitized.replace(reg, '$1[REDACTED]');
    }
    return sanitized;
  }
}

/**
 * Checks if a string looks like an Ed25519 seed or 12/24-word mnemonic.
 */
export function isMnemonic(val: string): boolean {
  if (typeof val !== 'string') return false;
  const words = val.trim().split(/\s+/);
  return (words.length === 12 || words.length === 24) && words.every(w => /^[a-z]+$/i.test(w));
}

/**
 * Checks if a string is a standard Solana public key or transaction signature.
 * - Public key: 32-44 base58 characters.
 * - Transaction signature: ~87-88 base58 characters.
 */
export function isLikelyPublicIdentifier(keyName: string, val: string): boolean {
  const lowerKey = keyName.toLowerCase();
  if (lowerKey === 'mint' || lowerKey === 'wallet' || lowerKey === 'walletid' || lowerKey === 'owner' || lowerKey === 'account') {
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(val);
  }
  if (lowerKey === 'signature' || lowerKey === 'txsignature' || lowerKey === 'tx_signature') {
    return /^[1-9A-HJ-NP-Za-km-z]{85,90}$/.test(val);
  }
  return false;
}

/**
 * Deeply sanitizes any telemetry payload.
 * Pure, immutable function: returns a new sanitized object.
 */
export function sanitizeTelemetry<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    // Check Authorization header pattern
    if (/^(Bearer|Basic)\s+[A-Za-z0-9._~+/-]+=*$/i.test(obj.trim())) {
      return '[REDACTED_AUTH]' as unknown as T;
    }
    // Check mnemonic
    if (isMnemonic(obj)) {
      return '[REDACTED_MNEMONIC]' as unknown as T;
    }
    // Check URL with credentials
    if (obj.includes('://') && (obj.includes('api-key=') || obj.includes('api_key=') || obj.includes('token='))) {
      return sanitizeUrl(obj) as unknown as T;
    }
    return obj;
  }

  if (typeof obj === 'bigint') {
    // Return string representation to ensure safe JSON serialization
    return obj.toString() as unknown as T;
  }

  if (typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    // Check if array is raw secret bytes (e.g. 64-byte private key keypair)
    if (obj.length === 64 && obj.every(x => typeof x === 'number' && x >= 0 && x <= 255)) {
      return '[REDACTED_BYTE_KEY]' as unknown as T;
    }
    return obj.map(item => sanitizeTelemetry(item)) as unknown as T;
  }

  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();

    // 1. Check signed transaction payload
    if (lowerKey === 'swaptransaction') {
      result[key] = '[REDACTED_TRANSACTION]';
      continue;
    }

    // 2. Preserve known public identifiers
    if (typeof value === 'string' && isLikelyPublicIdentifier(key, value)) {
      result[key] = value;
      continue;
    }

    // 3. Match secret key names
    if (SECRET_KEY_NAMES.has(lowerKey)) {
      result[key] = '[REDACTED_SECRET]';
      continue;
    }

    // 4. Sanitize URL strings
    if (typeof value === 'string' && value.includes('://')) {
      result[key] = sanitizeUrl(value);
      continue;
    }

    // 5. Recursive deep sanitization
    result[key] = sanitizeTelemetry(value);
  }

  return result as T;
}

/**
 * Safe JSON serializer that handles BigInt without throwing TypeError.
 */
export function safeJsonStringify(obj: unknown, space?: number): string {
  return JSON.stringify(
    obj,
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    space
  );
}
