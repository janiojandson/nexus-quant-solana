import { Keypair, Connection, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';

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
      const trimmed = (raw || '').trim();
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        const secretBytes = Uint8Array.from(JSON.parse(trimmed));
        return Keypair.fromSecretKey(secretBytes);
      }
      if (trimmed.length > 0) {
        // Tenta decodificar Base58 (formato padrão Phantom)
        try {
          const decoded = bs58.decode(trimmed);
          return Keypair.fromSecretKey(decoded);
        } catch {
          // Fallback para buffer hex se aplicável
          return Keypair.fromSecretKey(Buffer.from(trimmed, 'hex'));
        }
      }
      return Keypair.generate();
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

  public async getSplTokenAccounts(): Promise<Array<{ mint: string; tokenAmount: number; decimals: number; ataAddress: string }>> {
    try {
      const { PublicKey } = await import('@solana/web3.js');
      const response = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
      );
      return response.value
        .map(a => {
          const info = a.account.data.parsed.info;
          return {
            mint: info.mint as string,
            tokenAmount: Number(info.tokenAmount.uiAmount || 0),
            decimals: Number(info.tokenAmount.decimals || 0),
            ataAddress: a.pubkey.toBase58()
          };
        })
        .filter(t => t.tokenAmount > 0);
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
    try {
      const { PublicKey, Transaction, sendAndConfirmTransaction } = await import('@solana/web3.js');
      const { createCloseAccountInstruction, getAssociatedTokenAddress } = await import('@solana/spl-token');

      const mint = new PublicKey(mintAddress);
      const owner = this.keypair.publicKey;
      const ata = await getAssociatedTokenAddress(mint, owner);

      // Verifica se a conta existe antes de tentar fechar
      const accountInfo = await this.connection.getAccountInfo(ata);
      if (!accountInfo) {
        return { txSignature: null, success: true };
      }

      const closeIx = createCloseAccountInstruction(
        ata,          // Conta associada a ser fechada
        owner,        // Destino do SOL de aluguel (a própria carteira Phantom)
        owner         // Proprietário/Autoridade da conta
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
}
