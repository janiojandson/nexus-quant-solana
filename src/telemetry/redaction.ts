/**
 * Nexus Quant Solana — V2.0 Telemetry Redaction
 * Ensures zero secrets (private keys, seeds, API keys, bearer tokens, signed payloads)
 * leak into persistent telemetry, logs or metrics.
 *
 * HARDENED IDENTITY POLICY:
 * Public identifiers (mint, wallet, signature) are ONLY preserved if:
 * 1. The field name matches an authorized public field name.
 * 2. The string value decodes to exactly 32 bytes (PublicKey) or 64 bytes (Ed25519 Signature).
 *
 * CONSERVATIVE POLICY FOR UNKNOWN FIELDS:
 * Strings in unrecognized fields that decode as 32-byte or 64-byte base58 keys are
 * automatically redacted as [REDACTED_UNVERIFIED_KEY] to prevent accidental leakage.
 */

import bs58 from 'bs58';

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

const PUBLIC_KEY_FIELD_NAMES = new Set([
  'mint', 'wallet', 'walletid', 'owner', 'account'
]);

const SIGNATURE_FIELD_NAMES = new Set([
  'signature', 'txsignature', 'tx_signature'
]);

/**
 * Validates whether a value is structurally a valid Solana PublicKey:
 * 1. Base58 valid decoding
 * 2. Exactly 32 bytes decoded
 */
export function isValidSolanaPublicKey(val: string): boolean {
  if (typeof val !== 'string' || val.length < 32 || val.length > 44) return false;
  try {
    const decoded = bs58.decode(val);
    return decoded.length === 32;
  } catch {
    return false;
  }
}

/**
 * Validates whether a value is structurally a valid Solana Transaction Signature:
 * 1. Base58 valid decoding
 * 2. Exactly 64 bytes decoded (Ed25519 signature)
 */
export function isValidSolanaSignature(val: string): boolean {
  if (typeof val !== 'string' || val.length < 85 || val.length > 90) return false;
  try {
    const decoded = bs58.decode(val);
    return decoded.length === 64;
  } catch {
    return false;
  }
}

/**
 * Checks if a key-value pair is an authorized, structurally validated public identifier.
 * BOTH conditions must hold:
 * 1. Field name matches an authorized public field name.
 * 2. Value decodes via base58 to the exact expected byte length (32 for PublicKey, 64 for Signature).
 */
export function isAuthorizedPublicIdentifier(keyName: string, val: string): boolean {
  const lower = keyName.toLowerCase();
  if (PUBLIC_KEY_FIELD_NAMES.has(lower)) {
    return isValidSolanaPublicKey(val);
  }
  if (SIGNATURE_FIELD_NAMES.has(lower)) {
    return isValidSolanaSignature(val);
  }
  return false;
}

/**
 * Checks if an arbitrary string looks like a 32-byte or 64-byte Base58 key.
 * Used for conservative redaction on unknown fields.
 */
export function isDecodableBase58Key(val: string): boolean {
  if (typeof val !== 'string' || val.length < 32 || val.length > 90) return false;
  try {
    const decoded = bs58.decode(val);
    return decoded.length === 32 || decoded.length === 64;
  } catch {
    return false;
  }
}

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

    // 2. Check secret key names
    if (SECRET_KEY_NAMES.has(lowerKey)) {
      result[key] = '[REDACTED_SECRET]';
      continue;
    }

    // 3. Structural validation for expected public identifier fields
    if (PUBLIC_KEY_FIELD_NAMES.has(lowerKey) || SIGNATURE_FIELD_NAMES.has(lowerKey)) {
      if (typeof value === 'string' && isAuthorizedPublicIdentifier(key, value)) {
        result[key] = value;
      } else {
        result[key] = '[REDACTED_INVALID_IDENTIFIER]';
      }
      continue;
    }

    // 4. Sanitize URL strings
    if (typeof value === 'string' && value.includes('://')) {
      result[key] = sanitizeUrl(value);
      continue;
    }

    // 5. Conservative policy for unknown fields:
    // If an unknown field contains a string that decodes to a 32-byte or 64-byte Base58 key,
    // redact it to prevent accidental secret leakage.
    if (typeof value === 'string' && isDecodableBase58Key(value)) {
      result[key] = '[REDACTED_UNVERIFIED_KEY]';
      continue;
    }

    // 6. Recursive deep sanitization
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

/**
 * Sanitizes any log message or arbitrary string.
 */
export function sanitizeLogMessage(msg: string): string {
  if (!msg || typeof msg !== 'string') return '';
  return sanitizeTelemetry(msg);
}

/**
 * Alias for sanitizeTelemetry for structured payloads.
 */
export const sanitizeTelemetryPayload = sanitizeTelemetry;

