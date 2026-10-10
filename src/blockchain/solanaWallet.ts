import { Keypair, Connection, LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js';
import bs58 from 'bs58';
import { resolveExecutionMode, type ExecutionEnvironment } from '../execution/executionMode.js';

export interface WalletServiceConfig {
  connection?: Connection;
  secretKeyRaw?: string;
  publicKey?: string;
  executionEnv?: ExecutionEnvironment;
  rpcUrl?: string;
  rpcUrls?: string[];
}

export interface TradeValidationResult {
  allowed: boolean;
  reason?: string;
  maxAllowedAllocationSol: number;
}

export type WalletBalanceObservation =
  | { available: true; lamports: number; slot: number; observedAtMs: number;
      provenance: 'FRESH_CONFIRMED_RPC' }
  | { available: false; reason: 'WALLET_BALANCE_UNAVAILABLE' };

export function createResilientConnection(_urls: string[]): Connection {
  throw new Error('Direct RPC transport disabled; inject hub-backed connection');
}

export class SolanaWalletService {
  private keypair?: Keypair;
  private publicKey: PublicKey;
  private executionEnv: ExecutionEnvironment;
  private connection: Connection;
  private lastKnownBalanceSol: number | null = null;
  public static readonly MAX_TRADE_ALLOCATION_RATIO = 0.10; // Teto de 10%
  public static readonly MIN_GAS_RESERVE_SOL = 0.005; // Reserva intangível para taxas

  constructor(config: WalletServiceConfig) {
    this.executionEnv = config.executionEnv ?? process.env;
    if (resolveExecutionMode(this.executionEnv).shadow) {
      this.publicKey = new PublicKey(config.publicKey || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi');
    } else {
      this.keypair = this.parseKeypair(config.secretKeyRaw || '');
      this.publicKey = this.keypair.publicKey;
    }
    if (!config.connection) throw new Error('Hub-backed connection required');
    this.connection = config.connection;
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
    return this.publicKey.toBase58();
  }

  public getKeypair(): Keypair {
    if (!resolveExecutionMode(this.executionEnv).canSign || !this.keypair) {
      throw new Error('Signer unavailable in shadow mode.');
    }
    return this.keypair;
  }

  public getConnection(): Connection {
    return this.connection;
  }

  public async getBalanceSol(): Promise<number> {
    try {
      const lamports = await this.connection.getBalance(this.publicKey);
      if (!Number.isSafeInteger(lamports) || lamports < 0) throw new Error('INVALID_BALANCE');
      const bal = lamports / LAMPORTS_PER_SOL;
      this.lastKnownBalanceSol = bal;
      return bal;
    } catch (err: any) {
      if (this.lastKnownBalanceSol !== null) {
        console.warn('[SolanaWallet] Balance unavailable; returning cached display value only.');
        return this.lastKnownBalanceSol;
      }
      throw new Error('WALLET_BALANCE_UNAVAILABLE');
    }
  }

  /** getBalance is not hub-cacheable. Entry proof requires this new successful
   * confirmed observation; cached display values never satisfy admission. */
  public async readFreshBalance(): Promise<WalletBalanceObservation> {
    try {
      const result = await this.connection.getBalanceAndContext(this.publicKey, 'confirmed');
      if (!Number.isSafeInteger(result.value) || result.value < 0 ||
          !Number.isSafeInteger(result.context.slot) || result.context.slot <= 0)
        throw new Error('INVALID_BALANCE');
      this.lastKnownBalanceSol = result.value / LAMPORTS_PER_SOL;
      return { available: true, lamports: result.value, slot: result.context.slot,
        observedAtMs: Date.now(), provenance: 'FRESH_CONFIRMED_RPC' };
    } catch { return { available: false, reason: 'WALLET_BALANCE_UNAVAILABLE' }; }
  }

  /**
   * Consulta priorização de taxas dinâmicas na rede Solana
   */
  public async getDynamicPriorityFee(microLamportsDefault = 50_000): Promise<number> {
    try {
      const fees = await this.connection.getRecentPrioritizationFees();
      if (!fees || fees.length === 0) return microLamportsDefault;
      const sorted = fees.map(f => f.prioritizationFee).sort((a, b) => a - b);
      const p75 = sorted[Math.floor(sorted.length * 0.75)] || microLamportsDefault;
      return Math.max(microLamportsDefault, p75);
    } catch {
      return microLamportsDefault;
    }
  }

  /**
   * Lê da própria transação confirmada quanto deste mint entrou efetivamente
   * na carteira. Isso evita tratar o outAmount da quote Jupiter como saldo real:
   * slippage/execução podem fazer o post-balance diferir do valor cotado.
   */
  public async getReceivedTokenDeltaAtomic(
    txSignature: string,
    mintAddress: string
  ): Promise<string | null> {
    try {
      const tx = await this.connection.getParsedTransaction(txSignature, {
        commitment: 'confirmed',
        maxSupportedTransactionVersion: 0
      });
      if (!tx?.meta) return null;

      const owner = this.publicKey.toBase58();
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
   * Reconcilia uma execução V2 cuja resposta HTTP ficou incerta.
   * Procura transações recentes da própria wallet e devolve o delta real do mint.
   * Não transmite nada.
   */
  public async findRecentTokenDeltaTransaction(
    mintAddress: string,
    sinceTimestampMs: number,
    direction: 'IN' | 'OUT' | 'ANY' = 'ANY'
  ): Promise<{
    signature: string;
    deltaAtomic: string;
    walletLamportDelta: number;
    feeLamports: number;
    blockTimeMs: number;
  } | null> {
    try {
      const owner = this.publicKey.toBase58();
      const signatures = await this.connection.getSignaturesForAddress(
        this.publicKey,
        { limit: 30 },
        'confirmed'
      );

      for (const item of signatures) {
        const blockTimeMs = Number(item.blockTime || 0) * 1000;
        if (blockTimeMs > 0 && blockTimeMs < sinceTimestampMs - 5_000) continue;

        const tx = await this.connection.getParsedTransaction(item.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0
        });
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

  private async getParsedTokenAccountsForSupportedPrograms(): Promise<any[]> {
    const programIds = [
      new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'), // SPL Token clássico
      new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')  // Token-2022
    ];

    const accounts: any[] = [];
    for (const programId of programIds) {
      try {
        const response = await this.connection.getParsedTokenAccountsByOwner(
          this.publicKey,
          { programId }
        );
        accounts.push(...response.value);
      } catch (err: any) {
        console.warn(`⚠️ [Wallet] Falha ao consultar contas do programa ${programId.toBase58()}: ${err?.message || err}`);
      }
    }
    return accounts;
  }

  public async getSplTokenAccounts(): Promise<Array<{ mint: string; tokenAmount: number; atomicAmount: string; decimals: number; ataAddress: string }>> {
    try {
      const accounts = await this.getParsedTokenAccountsForSupportedPrograms();
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

  public async closeTokenAccount(mintAddress: string): Promise<{ txSignature: string | null; success: boolean }> {
    if (!resolveExecutionMode(this.executionEnv).canBroadcast || !this.keypair) {
      return { txSignature: null, success: false };
    }
    try {
      const { Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
      const {
        createCloseAccountInstruction,
        getAssociatedTokenAddress,
        TOKEN_PROGRAM_ID,
        TOKEN_2022_PROGRAM_ID
      } = await import('@solana/spl-token');

      const mint = new PublicKey(mintAddress);
      const owner = this.publicKey;
      const mintInfo = await this.connection.getAccountInfo(mint);
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
      const accountInfo = await this.connection.getAccountInfo(ata);
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
      const { blockhash } = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = owner;

      const txid = await sendAndConfirmTransaction(this.connection, transaction, [this.keypair]);
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
  public async sweepEmptyTokenAccounts(): Promise<{ closedCount: number; reclaimedSolEst: number; errors: string[] }> {
    if (!resolveExecutionMode(this.executionEnv).canBroadcast || !this.keypair) {
      return { closedCount: 0, reclaimedSolEst: 0, errors: [] };
    }
    try {
      const accounts = await this.getParsedTokenAccountsForSupportedPrograms();

      let closedCount = 0;
      const errors: string[] = [];

      for (const a of accounts) {
        const info = a.account.data.parsed.info;
        const amount = Number(info.tokenAmount.uiAmount || 0);
        const mint = info.mint as string;

        if (amount === 0 && mint) {
          try {
            const res = await this.closeTokenAccount(mint);
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
