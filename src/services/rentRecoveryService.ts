import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, createCloseAccountInstruction, TOKEN_PROGRAM_ID } from '@solana/spl-token';

export interface SweepResult {
  closedCount: number;
  reclaimedSolEst: number;
  errors: string[];
}

export interface SplAccountInfo {
  pubkey: string;
  mint: string;
  tokenAmount: number;
  decimals: number;
}

export class RentRecoveryService {
  private connection: Connection;
  private keypair?: Keypair;
  public static readonly RENT_EXEMPTION_EST_SOL = 0.00204;

  constructor(connection: Connection, keypair?: Keypair) {
    this.connection = connection;
    this.keypair = keypair;
  }

  /**
   * Constrói e envia instrução de fechamento de Associated Token Account (ATA)
   * transferindo a caução (~0.00204 SOL) de volta para o dono da carteira.
   */
  public async closeTokenAccount(mintAddress: string, destinationAddress?: string): Promise<{ success: boolean; txSignature?: string | null; error?: string }> {
    if (!this.keypair) {
      // Modo Simulado (Dry-Run / Sem Keypair)
      console.log(`🧹 [RentRecoveryService: SIMULAÇÃO] ATA de ${mintAddress} fechada virtualmente (~0.00204 SOL devolvidos).`);
      return { success: true, txSignature: 'DRY_RUN_ATA_CLOSED' };
    }

    try {
      const mintPubkey = new PublicKey(mintAddress);
      const ownerPubkey = this.keypair.publicKey;
      const ataAddress = getAssociatedTokenAddressSync(mintPubkey, ownerPubkey);
      const destination = destinationAddress ? new PublicKey(destinationAddress) : ownerPubkey;

      const instruction = createCloseAccountInstruction(
        ataAddress,
        destination,
        ownerPubkey,
        [],
        TOKEN_PROGRAM_ID
      );

      const transaction = new Transaction().add(instruction);
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.feePayer = ownerPubkey;

      const txid = await sendAndConfirmTransaction(this.connection, transaction, [this.keypair]);
      console.log(`💰 [RentRecoveryService] ATA de ${mintAddress} encerrada. ~0.00204 SOL devolvidos! Tx: ${txid}`);
      return { success: true, txSignature: txid };
    } catch (err: any) {
      const msg = err?.message || String(err);
      console.warn(`⚠️ [RentRecoveryService] Falha ao fechar ATA de ${mintAddress}: ${msg}`);
      return { success: false, txSignature: null, error: msg };
    }
  }

  /**
   * Sweeper de Inicialização & Manutenção:
   * Varre todas as contas SPL da carteira Phantom.
   * Se o saldo for 0 (órfã/vazia), dispara automaticamente a instrução de fechamento para resgatar aluguéis antigos esquecidos.
   */
  public async sweepOrphanAccounts(destinationAddress?: string): Promise<SweepResult> {
    if (!this.keypair) {
      return { closedCount: 0, reclaimedSolEst: 0, errors: [] };
    }

    try {
      const response = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      let closedCount = 0;
      const errors: string[] = [];

      for (const account of response.value) {
        const info = account.account.data.parsed?.info;
        if (!info) continue;

        const amount = Number(info.tokenAmount?.uiAmount || 0);
        const mint = info.mint as string;

        if (amount === 0 && mint) {
          try {
            const res = await this.closeTokenAccount(mint, destinationAddress);
            if (res.success && res.txSignature) {
              closedCount++;
            } else if (res.error) {
              errors.push(`${mint}: ${res.error}`);
            }
          } catch (e: any) {
            errors.push(`${mint}: ${e?.message || e}`);
          }
        }
      }

      const reclaimedSolEst = Number((closedCount * RentRecoveryService.RENT_EXEMPTION_EST_SOL).toFixed(6));
      if (closedCount > 0) {
        console.log(`🧹 [RentRecoveryService: Sweeper Concluído] ${closedCount} conta(s) órfã(s) fechada(s). ~${reclaimedSolEst} SOL recuperados!`);
      }
      return { closedCount, reclaimedSolEst, errors };
    } catch (err: any) {
      console.warn(`⚠️ [RentRecoveryService] Erro ao varrer contas órfãs: ${err?.message || err}`);
      return { closedCount: 0, reclaimedSolEst: 0, errors: [err?.message || String(err)] };
    }
  }

  /**
   * Varre todas as contas SPL com saldo > 0 da carteira
   */
  public async getSplAccountsWithBalance(): Promise<SplAccountInfo[]> {
    if (!this.keypair) return [];

    try {
      const response = await this.connection.getParsedTokenAccountsByOwner(
        this.keypair.publicKey,
        { programId: TOKEN_PROGRAM_ID }
      );

      const accounts: SplAccountInfo[] = [];
      for (const a of response.value) {
        const info = a.account.data.parsed?.info;
        if (!info) continue;

        const amount = Number(info.tokenAmount?.uiAmount || 0);
        const mint = info.mint as string;
        const decimals = Number(info.tokenAmount?.decimals || 0);

        if (amount > 0 && mint) {
          accounts.push({
            pubkey: a.pubkey.toBase58(),
            mint,
            tokenAmount: amount,
            decimals
          });
        }
      }
      return accounts;
    } catch {
      return [];
    }
  }
}
