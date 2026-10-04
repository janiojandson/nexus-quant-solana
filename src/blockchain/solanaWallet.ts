import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  nowMonotonicNs,
  nowWallMs,
  diffMonotonicMs,
  TelemetrySpan,
  SolanaRpcProviderAlias,
  SolanaRpcSpanMetadata,
  TradeId,
  PositionId
} from '../types/telemetry.js';
import {
  globalTelemetryBuffer,
  recordGlobalTelemetryInternalError
} from '../telemetry/telemetryBuffer.js';
import {
  sanitizeLogMessage,
  sanitizeTelemetryPayload
} from '../telemetry/redaction.js';

export { SolanaRpcProviderAlias };

export function resolveRpcProviderAlias(rpcUrl?: string): SolanaRpcProviderAlias {
  if (!rpcUrl || typeof rpcUrl !== 'string' || rpcUrl.trim() === '') {
    return 'SOLANA_PUBLIC';
  }
  const trimmed = rpcUrl.trim();
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return 'UNKNOWN';
    }
    const host = parsed.hostname.toLowerCase();
    if (host.includes('helius')) {
      return 'HELIUS';
    }
    if (host.includes('quicknode') || host.includes('quiknode')) {
      return 'QUICKNODE';
    }
    if (
      host === 'api.mainnet-beta.solana.com' ||
      host === 'api.devnet.solana.com' ||
      host === 'api.testnet.solana.com' ||
      host.endsWith('.solana.com') ||
      host === 'solana.com'
    ) {
      return 'SOLANA_PUBLIC';
    }
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.internal') ||
      host.endsWith('.local') ||
      host.includes('private') ||
      host.includes('custom') ||
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:'
    ) {
      return 'CUSTOM_PRIVATE';
    }
    return 'UNKNOWN';
  } catch {
    const lower = trimmed.toLowerCase();
    if (lower.includes('helius')) return 'HELIUS';
    if (lower.includes('quicknode') || lower.includes('quiknode')) return 'QUICKNODE';
    if (lower.includes('solana.com')) return 'SOLANA_PUBLIC';
    return 'UNKNOWN';
  }
}

export const JUPITER_V6_PROGRAM_ID = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
export const JUPITER_SWAP_PROGRAM_ID = JUPITER_V6_PROGRAM_ID;

export const JUPITER_PROGRAM_IDS = new Set([
  JUPITER_V6_PROGRAM_ID,
  'JUP4Fb2cqiRUcaTHdrPC8h2gNsA2ETXiPDD33WcGuJB',
  'JUP3c2Uh3WA4Ng34tw6kPd2G4C5BB21Xo36Je1s32Ph'
]);

export const JUPITER_KNOWN_ERRORS: Record<number, string> = {
  6001: 'JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED',
  6008: 'JUPITER_NOT_ENOUGH_ACCOUNT_KEYS',
  6014: 'JUPITER_INCORRECT_TOKEN_PROGRAM_ID',
  6017: 'JUPITER_EXACT_OUT_AMOUNT_NOT_MATCHED',
  6024: 'JUPITER_INSUFFICIENT_FUNDS',
  6025: 'JUPITER_INVALID_TOKEN_ACCOUNT'
};

export function parseRpcError(err: any): {
  timedOut: boolean;
  errorClass: string;
  customProgramError?: {
    programId?: string;
    customCode?: number | string;
    instructionIndex?: number;
    logsDigest?: string;
    classification?: string;
    classificationSource?: string;
    classificationVersion?: string;
  };
} {
  const message = String(err?.message || err || '');
  const name = String(err?.name || err?.constructor?.name || '');

  const timedOut =
    name === 'TimeoutError' ||
    name === 'AbortError' ||
    err?.code === 'ETIMEDOUT' ||
    /timeout|timed\s*out/i.test(message);

  const errorClass = timedOut
    ? 'TimeoutError'
    : name || (err?.code ? `RpcError:${err.code}` : 'RpcError');

  let customCode: number | string | undefined = err?.customProgramError?.customCode;
  let instructionIndex: number | undefined = err?.customProgramError?.instructionIndex;
  let programId: string | undefined = err?.customProgramError?.programId || err?.programId;
  const programIdProven = Boolean(programId);

  // 1. InstructionError array: [index, { Custom: code }]
  if (Array.isArray(err?.instructionError)) {
    if (typeof err.instructionError[0] === 'number') {
      instructionIndex = err.instructionError[0];
    }
    const detail = err.instructionError[1];
    if (detail && typeof detail === 'object' && 'Custom' in detail) {
      customCode = detail.Custom;
    }
  }

  // 2. Custom code from message regex
  if (customCode === undefined) {
    const customMatch = message.match(/custom program error:\s*(0x[0-9a-fA-F]+|\d+)/i);
    if (customMatch) {
      const codeStr = customMatch[1];
      customCode = codeStr.startsWith('0x') || codeStr.startsWith('0X')
        ? parseInt(codeStr, 16)
        : parseInt(codeStr, 10);
    }
  }

  // 3. Instruction index from message regex
  if (instructionIndex === undefined) {
    const ixMatch = message.match(/instruction\s+(\d+)/i);
    if (ixMatch) {
      instructionIndex = parseInt(ixMatch[1], 10);
    }
  }

  // 4. Logs inspection for programId and logsDigest
  const rawLogs = err?.logs || (Array.isArray(err?.transactionLogs) ? err.transactionLogs : undefined);
  let logsDigest: string | undefined;

  if (Array.isArray(rawLogs) && rawLogs.length > 0) {
    const joined = rawLogs
      .filter((l): l is string => typeof l === 'string')
      .slice(0, 3)
      .join(' | ');
    const sanitized = sanitizeLogMessage(joined);
    logsDigest = sanitized.length > 200 ? sanitized.slice(0, 197) + '...' : sanitized;

    // Rule 10: contradictory logs must NOT silently replace proven programId
    if (!programIdProven) {
      // Prioritize explicit failure line: "Program <id> failed:"
      for (const log of rawLogs) {
        if (typeof log !== 'string') continue;
        const failedMatch = log.match(/Program\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s+failed/i);
        if (failedMatch) {
          programId = failedMatch[1];
          break;
        }
      }
      // If no explicit failure line, look for the LAST invoked program
      if (!programId) {
        for (let i = rawLogs.length - 1; i >= 0; i--) {
          const log = rawLogs[i];
          if (typeof log !== 'string') continue;
          const invokeMatch = log.match(/Program\s+([1-9A-HJ-NP-Za-km-z]{32,44})\s+invoke/i);
          if (invokeMatch) {
            programId = invokeMatch[1];
            break;
          }
        }
      }
    }
  } else if (message.length > 0) {
    const sanitized = sanitizeLogMessage(message);
    logsDigest = sanitized.length > 200 ? sanitized.slice(0, 197) + '...' : sanitized;
  }

  if (!logsDigest && err?.customProgramError?.logsDigest) {
    logsDigest = sanitizeLogMessage(String(err.customProgramError.logsDigest));
  }

  let customProgramError: {
    programId?: string;
    customCode?: number | string;
    instructionIndex?: number;
    logsDigest?: string;
    classification?: string;
    classificationSource?: string;
    classificationVersion?: string;
  } | undefined = undefined;

  if (customCode !== undefined || programId !== undefined) {
    let classification = 'UNKNOWN';
    let classificationSource = 'UNKNOWN';
    const classificationVersion = '2026-10-04';

    if (programId && JUPITER_PROGRAM_IDS.has(programId)) {
      const numericCode = Number(customCode);
      if (JUPITER_KNOWN_ERRORS[numericCode]) {
        classification = JUPITER_KNOWN_ERRORS[numericCode];
        classificationSource = 'JUPITER_SWAP_PROGRAM_KNOWN_ERRORS';
      }
    }

    customProgramError = {
      programId: programId ? sanitizeLogMessage(programId) : undefined,
      customCode,
      instructionIndex,
      logsDigest,
      classification,
      classificationSource,
      classificationVersion
    };
  }

  return {
    timedOut,
    errorClass,
    customProgramError
  };
}

export function classifySolanaProgramError(
  programId?: string | null,
  customCode?: number | string | null,
  logs?: string[] | string
): {
  classification: string;
  classificationSource: string;
  classificationVersion: string;
  programId?: string;
  customCode?: number | string;
  instructionIndex?: number;
  logsDigest?: string;
} {
  const errObj: any = {
    programId: programId ?? undefined,
    customProgramError: {
      customCode: customCode ?? undefined
    }
  };
  if (Array.isArray(logs)) {
    errObj.logs = logs;
  } else if (typeof logs === 'string') {
    errObj.message = logs;
  }
  const parsed = parseRpcError(errObj);
  return {
    classification: parsed.customProgramError?.classification || 'UNKNOWN',
    classificationSource: parsed.customProgramError?.classificationSource || 'UNKNOWN',
    classificationVersion: parsed.customProgramError?.classificationVersion || '2026-10-04',
    programId: parsed.customProgramError?.programId,
    customCode: parsed.customProgramError?.customCode,
    instructionIndex: parsed.customProgramError?.instructionIndex,
    logsDigest: parsed.customProgramError?.logsDigest
  };
}

export interface WalletServiceConfig {
  secretKeyRaw: string;
  rpcUrl?: string;
  providerAlias?: SolanaRpcProviderAlias;
}

export interface TradeValidationResult {
  allowed: boolean;
  reason?: string;
  maxAllowedAllocationSol: number;
}

export class SolanaWalletService {
  private keypair: Keypair;
  private connection: Connection;
  private readonly providerAlias: SolanaRpcProviderAlias;
  public static readonly MAX_TRADE_ALLOCATION_RATIO = 0.10; // Teto de 10%
  public static readonly MIN_GAS_RESERVE_SOL = 0.005; // Reserva intangível para taxas

  constructor(config: WalletServiceConfig) {
    this.keypair = this.parseKeypair(config.secretKeyRaw);
    this.connection = new Connection(config.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
    this.providerAlias = config.providerAlias || resolveRpcProviderAlias(config.rpcUrl);
  }

  public getProviderAlias(): SolanaRpcProviderAlias {
    return this.providerAlias;
  }

  private async measureRpcCall<T>(
    methodName: string,
    callFn: () => Promise<T>,
    options?: {
      commitment?: string;
      timeoutConfiguredMs?: number;
      attemptNumber?: number;
      traceId?: string;
      tradeId?: TradeId;
      positionId?: PositionId;
      attemptId?: string;
      requestId?: string;
    }
  ): Promise<T> {
    const startMonoNs = nowMonotonicNs();
    let rawResult: T | undefined = undefined;
    let succeeded = false;
    let callError: any = null;

    try {
      rawResult = await callFn();
      succeeded = true;
      return rawResult;
    } catch (err: any) {
      callError = err;
      throw err;
    } finally {
      const endMonoNs = nowMonotonicNs();
      try {
        const durationMs = diffMonotonicMs(startMonoNs, endMonoNs);

        let sourceSlot: number | undefined = undefined;
        if (succeeded && rawResult !== undefined && rawResult !== null) {
          if (typeof (rawResult as any)?.context?.slot === 'number') {
            sourceSlot = (rawResult as any).context.slot;
          } else if (typeof (rawResult as any)?.slot === 'number') {
            sourceSlot = (rawResult as any).slot;
          }
        }

        const parsedError = !succeeded ? parseRpcError(callError) : null;

        const metadata: SolanaRpcSpanMetadata = {
          providerAlias: this.providerAlias,
          method: methodName,
          commitment: options?.commitment,
          sourceSlot,
          success: succeeded,
          timedOut: parsedError?.timedOut ?? false,
          errorClass: succeeded ? undefined : parsedError?.errorClass,
          customProgramError: succeeded ? undefined : parsedError?.customProgramError,
          attemptNumber: options?.attemptNumber,
          timeoutConfiguredMs: options?.timeoutConfiguredMs,
          elapsedMs: durationMs,
          rpcStartedMonoNs: startMonoNs.toString(),
          rpcCompletedMonoNs: endMonoNs.toString(),
          tradeId: options?.tradeId,
          positionId: options?.positionId,
          attemptId: options?.attemptId,
          requestId: options?.requestId
        };

        const span: TelemetrySpan = {
          id: `rpc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
          traceId: options?.traceId || `trace_rpc_${Date.now()}`,
          spanName: 'solana_rpc',
          providerAlias: this.providerAlias,
          durationMs,
          status: succeeded ? 'SUCCESS' : 'ERROR',
          metadata: sanitizeTelemetryPayload(metadata as unknown as Record<string, unknown>),
          createdAtWallMs: nowWallMs()
        };

        globalTelemetryBuffer.push(span);
      } catch {
        recordGlobalTelemetryInternalError();
      }
    }
  }


  private parseKeypair(raw: string): Keypair {
    const trimmed = (raw || '').trim();
    if (!trimmed || trimmed === '[]') {
      throw new Error('Chave privada Solana ausente. Inicializa??o abortada por seguran?a.');
    }

    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed) || parsed.some((v: unknown) => !Number.isInteger(v) || Number(v) < 0 || Number(v) > 255)) {
          throw new Error('Array de chave secreta inv?lido.');
        }
        return Keypair.fromSecretKey(Uint8Array.from(parsed));
      } catch (err: any) {
        throw new Error(`Chave privada Solana inv?lida: ${err?.message || err}`);
      }
    }

    try {
      return Keypair.fromSecretKey(bs58.decode(trimmed));
    } catch {
      try {
        if (!/^(?:[0-9a-fA-F]{2})+$/.test(trimmed)) throw new Error('Formato n?o reconhecido.');
        return Keypair.fromSecretKey(Buffer.from(trimmed, 'hex'));
      } catch (err: any) {
        throw new Error(`Chave privada Solana inv?lida: ${err?.message || err}`);
      }
    }
  }

  public getPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  public getKeypair(): Keypair {
    return this.keypair;
  }

  public getConnection(): Connection {
    return this.connection;
  }

  public async getBalanceSol(context?: { traceId?: string }): Promise<number> {
    try {
      const lamports = await this.measureRpcCall(
        'getBalance',
        () => this.connection.getBalance(this.keypair.publicKey),
        { commitment: 'confirmed', traceId: context?.traceId }
      );
      return lamports / LAMPORTS_PER_SOL;
    } catch {
      return 0;
    }
  }

  public async getSignatureStatus(
    signature: string,
    context?: { traceId?: string }
  ): Promise<{
    confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
    err: any | null;
  } | null> {
    if (!signature || signature.startsWith('dry_run_')) {
      return { confirmationStatus: 'confirmed', err: null };
    }
    if (typeof this.connection?.getSignatureStatus !== 'function') {
      return { confirmationStatus: 'confirmed', err: null };
    }
    try {
      const response = await this.measureRpcCall(
        'getSignatureStatus',
        () => this.connection.getSignatureStatus(signature, { searchTransactionHistory: true }),
        { commitment: 'confirmed', traceId: context?.traceId }
      );
      if (!response?.value) return null;
      return {
        confirmationStatus: response.value.confirmationStatus || null,
        err: response.value.err || null
      };
    } catch (err: any) {
      console.warn(`⚠️ [Wallet] Falha ao consultar status da assinatura ${signature}: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Lê da própria transação confirmada quanto deste mint entrou efetivamente
   * na carteira. Isso evita tratar o outAmount da quote Jupiter como saldo real:
   * slippage/execução podem fazer o post-balance diferir do valor cotado.
   */
  public async getReceivedTokenDeltaAtomic(
    txSignature: string,
    mintAddress: string,
    context?: { traceId?: string; tradeId?: TradeId }
  ): Promise<string | null> {
    try {
      const tx = await this.measureRpcCall(
        'getParsedTransaction',
        () => this.connection.getParsedTransaction(txSignature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        }),
        { commitment: 'confirmed', traceId: context?.traceId, tradeId: context?.tradeId }
      );
      if (!tx?.meta) return null;

      const owner = this.keypair.publicKey.toBase58();
      const sumForOwner = (balances: any[] | null | undefined): bigint => {
        let total = 0n;
        for (const balance of balances || []) {
          if (balance?.mint !== mintAddress || balance?.owner !== owner) continue;
          const raw = String(balance?.uiTokenAmount?.amount ?? '0');
          if (!/^\d+$/.test(raw)) continue;
          total += BigInt(raw);
        }
        return total;
      };

      const pre = sumForOwner(tx.meta.preTokenBalances);
      const post = sumForOwner(tx.meta.postTokenBalances);
      const delta = post - pre;
      return delta > 0n ? delta.toString() : null;
    } catch (err: any) {
      console.warn(
        `⚠️ [Wallet] Não foi possível obter delta atômico da tx ${txSignature}: ${err?.message || err}`
      );
      return null;
    }
  }

  /**
   * Reconciles a transaction strictly by its EXACT signature (Finding R-P0-03).
   * It never scans arbitrary wallet transactions to avoid attributing third-party
   * transactions (transfers, airdrops, other swaps) to this execution attempt.
   */
  public async reconcileExactTransaction(params: {
    signature: string;
    mintAddress: string;
    expectedOwner?: string;
    direction?: 'IN' | 'OUT' | 'ANY';
    context?: { traceId?: string; tradeId?: TradeId };
  }): Promise<{
    signature: string;
    slot?: number;
    deltaAtomic: string;
    remainingCustodyAtomic?: string;
    inputTokenAccount?: string;
    walletLamportDelta: number;
    feeLamports: number;
    blockTimeMs: number;
    success: boolean;
    error?: string;
  } | null> {
    if (!params.signature || params.signature.trim() === '') {
      return null;
    }

    try {
      const owner = params.expectedOwner || this.keypair.publicKey.toBase58();
      const tx = await this.measureRpcCall(
        'getParsedTransaction',
        () => this.connection.getParsedTransaction(params.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        }),
        { commitment: 'confirmed', traceId: params.context?.traceId, tradeId: params.context?.tradeId }
      );

      if (!tx) {
        return null; // Not found on-chain yet or dropped
      }

      if (tx.meta?.err) {
        return {
          signature: params.signature,
          deltaAtomic: '0',
          walletLamportDelta: 0,
          feeLamports: Number(tx.meta.fee || 0),
          blockTimeMs: Number(tx.blockTime || 0) * 1000,
          success: false,
          error: `Transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`
        };
      }

      const sumForOwner = (balances: any[] | null | undefined): bigint => {
        let total = 0n;
        for (const balance of balances || []) {
          if (balance?.mint !== params.mintAddress || balance?.owner !== owner) continue;
          const raw = String(balance?.uiTokenAmount?.amount ?? '0');
          if (/^\d+$/.test(raw)) total += BigInt(raw);
        }
        return total;
      };

      const delta = sumForOwner(tx.meta?.postTokenBalances) - sumForOwner(tx.meta?.preTokenBalances);
      const direction = params.direction || 'ANY';
      if (direction === 'IN' && delta <= 0n) return null;
      if (direction === 'OUT' && delta >= 0n) return null;

      const accountKeys = tx.transaction.message.accountKeys.map((key: any) =>
        key.pubkey?.toBase58 ? key.pubkey.toBase58() : String(key.pubkey || key)
      );
      const ownerIndex = accountKeys.indexOf(owner);
      const walletLamportDelta = ownerIndex >= 0 && tx.meta?.postBalances && tx.meta?.preBalances
        ? Number(tx.meta.postBalances[ownerIndex] - tx.meta.preBalances[ownerIndex])
        : 0;

      let inputTokenAccount: string | undefined;
      for (const balance of tx.meta?.preTokenBalances || []) {
        if (balance?.mint === params.mintAddress && balance?.owner === owner) {
          if (balance.accountIndex !== undefined && accountKeys[balance.accountIndex]) {
            inputTokenAccount = accountKeys[balance.accountIndex];
            break;
          }
        }
      }

      return {
        signature: params.signature,
        slot: tx.slot,
        deltaAtomic: delta.toString(),
        remainingCustodyAtomic: sumForOwner(tx.meta?.postTokenBalances).toString(),
        inputTokenAccount,
        walletLamportDelta,
        feeLamports: Number(tx.meta?.fee || 0),
        blockTimeMs: Number(tx.blockTime || 0) * 1000,
        success: true
      };
    } catch (err: any) {
      console.warn(`⚠️ [Wallet:ReconcileExact] Falha ao consultar assinatura ${params.signature}: ${err?.message || err}`);
      return null;
    }
  }

  /**
   * Reconcilia uma execução V2 cuja resposta HTTP ficou incerta.
   * Procura transações recentes da própria wallet e devolve o delta real do mint.
   * Não transmite nada.
   */
  public async findRecentTokenDeltaTransaction(
    mintAddress: string,
    sinceTimestampMs: number,
    direction: 'IN' | 'OUT' | 'ANY' = 'ANY',
    context?: { traceId?: string; tradeId?: TradeId }
  ): Promise<{
    signature: string;
    deltaAtomic: string;
    walletLamportDelta: number;
    feeLamports: number;
    blockTimeMs: number;
  } | null> {
    try {
      const owner = this.keypair.publicKey.toBase58();
      const signatures = await this.measureRpcCall(
        'getSignaturesForAddress',
        () => this.connection.getSignaturesForAddress(
          this.keypair.publicKey,
          { limit: 30 },
          'confirmed'
        ),
        { commitment: 'confirmed', traceId: context?.traceId, tradeId: context?.tradeId }
      );

      for (const item of (signatures || [])) {
        const blockTimeMs = Number(item.blockTime || 0) * 1000;
        if (blockTimeMs > 0 && blockTimeMs < sinceTimestampMs - 5_000) continue;

        const tx = await this.measureRpcCall(
          'getParsedTransaction',
          () => this.connection.getParsedTransaction(item.signature, {
            commitment: 'confirmed',
            maxSupportedTransactionVersion: 0
          }),
          { commitment: 'confirmed', traceId: context?.traceId, tradeId: context?.tradeId }
        );
        if (!tx?.meta) continue;

        const sumForOwner = (balances: any[] | null | undefined): bigint => {
          let total = 0n;
          for (const balance of balances || []) {
            if (balance?.mint !== mintAddress || balance?.owner !== owner) continue;
            const raw = String(balance?.uiTokenAmount?.amount ?? '0');
            if (/^\d+$/.test(raw)) total += BigInt(raw);
          }
          return total;
        };

        const delta = sumForOwner(tx.meta.postTokenBalances) - sumForOwner(tx.meta.preTokenBalances);
        if (delta === 0n) continue;
        if (direction === 'IN' && delta <= 0n) continue;
        if (direction === 'OUT' && delta >= 0n) continue;

        const accountKeys = tx.transaction.message.accountKeys.map((key: any) =>
          key.pubkey?.toBase58 ? key.pubkey.toBase58() : String(key.pubkey || key)
        );
        const ownerIndex = accountKeys.indexOf(owner);
        const walletLamportDelta = ownerIndex >= 0
          ? Number(tx.meta.postBalances[ownerIndex] - tx.meta.preBalances[ownerIndex])
          : 0;

        return {
          signature: item.signature,
          deltaAtomic: delta.toString(),
          walletLamportDelta,
          feeLamports: Number(tx.meta.fee || 0),
          blockTimeMs
        };
      }

      return null;
    } catch (err: any) {
      console.warn(
        `⚠️ [Wallet:Reconciliação V2] Falha ao procurar delta de ${mintAddress}: ${err?.message || err}`
      );
      return null;
    }
  }

  private async getParsedTokenAccountsForSupportedPrograms(context?: { traceId?: string }): Promise<any[]> {
    const programIds = [
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // SPL Token clássico
      new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')  // Token-2022
    ];

    const accounts: any[] = [];
    for (const programId of programIds) {
      try {
        const response = await this.measureRpcCall(
          'getParsedTokenAccountsByOwner',
          () => this.connection.getParsedTokenAccountsByOwner(
            this.keypair.publicKey,
            { programId }
          ),
          { commitment: 'confirmed', traceId: context?.traceId }
        );
        const items = Array.isArray(response) ? response : (response?.value || []);
        accounts.push(...items);
      } catch (err: any) {
        console.warn(`⚠️ [Wallet] Falha ao consultar contas do programa ${programId.toBase58()}: ${err?.message || err}`);
      }
    }
    return accounts;
  }

  public async getSplTokenAccounts(context?: { traceId?: string }): Promise<Array<{ mint: string; tokenAmount: number; atomicAmount: string; decimals: number; ataAddress: string }>> {
    try {
      const accounts = await this.getParsedTokenAccountsForSupportedPrograms(context);
      return accounts
        .map(a => {
          const info = a.account.data.parsed.info;
          return {
            mint: info.mint as string,
            tokenAmount: Number(info.tokenAmount.uiAmount || 0),
            atomicAmount: String(info.tokenAmount.amount || '0'),
            decimals: Number(info.tokenAmount.decimals || 0),
            ataAddress: a.pubkey.toBase58()
          };
        })
        .filter(t => /^\d+$/.test(t.atomicAmount) && BigInt(t.atomicAmount) > 0n);
    } catch {
      return [];
    }
  }

  public validateTradeAllocation(tradeAmountSol: number, totalBalanceSol: number): TradeValidationResult {
    const maxAllowed = totalBalanceSol * SolanaWalletService.MAX_TRADE_ALLOCATION_RATIO;

    // Checagem de reserva de gas
    if (totalBalanceSol <= SolanaWalletService.MIN_GAS_RESERVE_SOL) {
      return {
        allowed: false,
        reason: `Reserva de gas insuficiente. Saldo total (${totalBalanceSol} SOL) <= Reserva mínima (${SolanaWalletService.MIN_GAS_RESERVE_SOL} SOL).`,
        maxAllowedAllocationSol: 0
      };
    }

    // Checagem de teto de risco (10%)
    if (tradeAmountSol > maxAllowed + 0.000001) {
      return {
        allowed: false,
        reason: `Teto de risco excedido: O trade de ${tradeAmountSol} SOL excede 10% do saldo total (${maxAllowed.toFixed(4)} SOL).`,
        maxAllowedAllocationSol: Number(maxAllowed.toFixed(6))
      };
    }

    return {
      allowed: true,
      maxAllowedAllocationSol: Number(maxAllowed.toFixed(6))
    };
  }

  // Previne que a chave privada seja serializada em JSON ou logs acidentais
  public toJSON(): Record<string, unknown> {
    return {
      publicKey: this.getPublicKey(),
      network: 'solana-mainnet'
    };
  }

  public async closeTokenAccount(
    mintAddress: string,
    context?: { traceId?: string; tradeId?: TradeId; positionId?: PositionId }
  ): Promise<{ txSignature: string | null; success: boolean }> {
    try {
      const { Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
      const {
        createCloseAccountInstruction,
        getAssociatedTokenAddress,
        TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID
      } = await import('@solana/spl-token');

      const mint = new PublicKey(mintAddress);
      const owner = this.keypair.publicKey;
      const mintInfo = await this.measureRpcCall(
        'getAccountInfo',
        () => this.connection.getAccountInfo(mint),
        { commitment: 'confirmed', traceId: context?.traceId, tradeId: context?.tradeId, positionId: context?.positionId }
      );
      if (!mintInfo) {
        throw new Error(`Mint inexistente: ${mintAddress}`);
      }

      const tokenProgramId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
        ? TOKEN_2022_PROGRAM_ID
        : mintInfo.owner.equals(TOKEN_PROGRAM_ID)
          ? TOKEN_PROGRAM_ID
          : null;
      if (!tokenProgramId) {
        throw new Error(`Programa de token não suportado para ${mintAddress}: ${mintInfo.owner.toBase58()}`);
      }

      const ata = await getAssociatedTokenAddress(mint, owner, false, tokenProgramId);

      // Verifica se a conta existe antes de tentar fechar
      const accountInfo = await this.measureRpcCall(
        'getAccountInfo',
        () => this.connection.getAccountInfo(ata),
        { commitment: 'confirmed', traceId: context?.traceId, tradeId: context?.tradeId, positionId: context?.positionId }
      );
      if (!accountInfo) {
        return { txSignature: null, success: true };
      }

      const closeIx = createCloseAccountInstruction(
        ata,          // Conta associada a ser fechada
        owner,        // Destino do SOL de aluguel (a própria carteira Phantom)
        owner,        // Proprietário/Autoridade da conta
        [],           // Multi-signers
        tokenProgramId
      );

      const transaction = new Transaction().add(closeIx);
      const blockhashRes = await this.measureRpcCall(
        'getLatestBlockhash',
        () => this.connection.getLatestBlockhash('confirmed'),
        { commitment: 'confirmed', traceId: context?.traceId, tradeId: context?.tradeId, positionId: context?.positionId }
      );
      const { blockhash } = blockhashRes;
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = owner;

      const txid = await this.measureRpcCall(
        'sendAndConfirmTransaction',
        () => sendAndConfirmTransaction(this.connection, transaction, [this.keypair]),
        { commitment: 'confirmed', traceId: context?.traceId, tradeId: context?.tradeId, positionId: context?.positionId }
      );
      console.log(`💰 [Rent Exemption Resgatado] ATA de ${mintAddress} fechada com sucesso. ~0.00204 SOL devolvidos! Tx: ${txid}`);
      return { txSignature: txid, success: true };
    } catch (err: any) {
      console.warn(`⚠️ [Aviso Fechamento ATA] Não foi possível fechar ATA de ${mintAddress}: ${err?.message || err}`);
      return { txSignature: null, success: false };
    }
  }

  /**
   * Varredura Automática de Rent (Higiene On-Chain):
   * Localiza todas as contas associadas (ATAs) que possuem saldo ZERO (uiAmount === 0)
   * e executa o fechamento (createCloseAccountInstruction), resgatando a caução (~0.00204 SOL por ATA)
   * diretamente para a carteira Phantom.
   */
  public async sweepEmptyTokenAccounts(context?: { traceId?: string }): Promise<{ closedCount: number; reclaimedSolEst: number; errors: string[] }> {
    try {
      const accounts = await this.getParsedTokenAccountsForSupportedPrograms(context);

      let closedCount = 0;
      const errors: string[] = [];

      for (const a of accounts) {
        const info = a.account.data.parsed.info;
        const amount = Number(info.tokenAmount.uiAmount || 0);
        const mint = info.mint as string;

        if (amount === 0 && mint) {
          try {
            const res = await this.closeTokenAccount(mint, context);
            if (res.success && res.txSignature) {
              closedCount++;
            }
          } catch (e: any) {
            errors.push(`${mint}: ${e?.message || e}`);
          }
        }
      }

      const reclaimedSolEst = Number((closedCount * 0.00204).toFixed(6));
      if (closedCount > 0) {
        console.log(`🧹 [Varredura de Rent Concluída]: ${closedCount} conta(s) vazia(s) fechada(s). ~${reclaimedSolEst} SOL recuperados para a carteira!`);
      }
      return { closedCount, reclaimedSolEst, errors };
    } catch (err: any) {
      console.warn(`⚠️ [Aviso Sweep Rent]: Falha na varredura de contas: ${err?.message || err}`);
      return { closedCount: 0, reclaimedSolEst: 0, errors: [err?.message || String(err)] };
    }
  }
}
