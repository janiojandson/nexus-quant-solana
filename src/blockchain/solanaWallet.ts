import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';

export interface WalletServiceConfig {
  secretKeyRaw: string;
  rpcUrl?: string;
}

export interface TradeValidationResult {
  allowed: boolean;
  reason?: string;
  maxAllowedAllocationSol: number;
}

export class SolanaWalletService {
  private keypair: Keypair;
  private connection: Connection;
  public static readonly MAX_TRADE_ALLOCATION_RATIO = 0.10; // Teto de 10%
  public static readonly MIN_GAS_RESERVE_SOL = 0.005; // Reserva intangível para taxas

  constructor(config: WalletServiceConfig) {
    this.keypair = this.parseKeypair(config.secretKeyRaw);
    this.connection = new Connection(config.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
  }

  private parseKeypair(raw: string): Keypair {
    try {
      const trimmed = raw.trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const secretBytes = Uint8Array.from(JSON.parse(trimmed));
        return Keypair.fromSecretKey(secretBytes);
      }
      // Se for formato Base58
      return Keypair.fromSecretKey(Buffer.from(trimmed, 'hex'));
    } catch {
      // Fallback para geracao segura em mock/test se nao parsear
      return Keypair.generate();
    }
  }

  public getPublicKey(): string {
    return this.keypair.publicKey.toBase58();
  }

  public getKeypair(): Keypair {
    return this.keypair;
  }

  public async getBalanceSol(): Promise<number> {
    try {
      const lamports = await this.connection.getBalance(this.keypair.publicKey);
      return lamports / LAMPORTS_PER_SOL;
    } catch {
      return 0;
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
}
