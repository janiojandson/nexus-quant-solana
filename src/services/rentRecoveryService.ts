import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { resolveExecutionMode, type ExecutionEnvironment } from '../execution/executionMode.js';
import {
  getAssociatedTokenAddressSync,
  createCloseAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID
} from '@solana/spl-token';

export interface SweepResult {
  closedCount: number;
  reclaimedSolEst: number;
  reclaimedSolActual: number;
  txSignatures: string[];
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
  private publicKey?: PublicKey;
  private executionEnv: ExecutionEnvironment;
  public static readonly RENT_EXEMPTION_EST_SOL = 0.00204;

  constructor(connection: Connection, keypair?: Keypair, executionEnv: ExecutionEnvironment = process.env, publicKey?: PublicKey) {
    this.connection = connection;
    this.keypair = keypair;
    this.publicKey = publicKey ?? keypair?.publicKey;
    this.executionEnv = executionEnv;
  }

  private async getParsedTokenAccountsForSupportedPrograms(): Promise<any[]> {
    if (!this.publicKey) return [];
    const accounts: any[] = [];
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      try {
        const response = await this.connection.getParsedTokenAccountsByOwner(
          this.publicKey,
          { programId }
        );
        accounts.push(...response.value);
      } catch (err: any) {
        console.warn(
          `⚠️ [RentRecoveryService] Falha ao consultar ${programId.toBase58()}: ${err?.message || err}`
        );
      }
    }
    return accounts;
  }

  private async resolveTokenProgram(mint: PublicKey): Promise<PublicKey> {
    const mintInfo = await this.connection.getAccountInfo(mint);
    if (!mintInfo) throw new Error(`Mint inexistente: ${mint.toBase58()}`);
    if (mintInfo.owner.equals(TOKEN_PROGRAM_ID)) return TOKEN_PROGRAM_ID;
    if (mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    throw new Error(
      `Programa de token não suportado para ${mint.toBase58()}: ${mintInfo.owner.toBase58()}`
    );
  }

  private async closeAccountAddress(
    tokenAccountAddress: PublicKey,
    destinationAddress?: string,
    tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
  ): Promise<{ success: boolean; txSignature?: string | null; error?: string }> {
    if (!resolveExecutionMode(this.executionEnv).canBroadcast || !this.keypair) {
      return { success: false, txSignature: null, error: 'Shadow mode: rent closure blocked.' };
    }

    try {
      const ownerPubkey = this.keypair.publicKey;
      const destination = destinationAddress ? new PublicKey(destinationAddress) : ownerPubkey;
      const instruction = createCloseAccountInstruction(
        tokenAccountAddress,
        destination,
        ownerPubkey,
        [],
        tokenProgramId
      );

      const transaction = new Transaction().add(instruction);
      const latestBlockhash = await this.connection.getLatestBlockhash('confirmed');
      transaction.recentBlockhash = latestBlockhash.blockhash;
      transaction.feePayer = ownerPubkey;

      const txid = await sendAndConfirmTransaction(this.connection, transaction, [this.keypair], {
        commitment: 'confirmed'
      });
      return { success: true, txSignature: txid };
    } catch (err: any) {
      return { success: false, txSignature: null, error: err?.message || String(err) };
    }
  }

  /**
   * Fecha a ATA associada ao mint informado e devolve o rent para a carteira.
   * Usado após liquidações em que conhecemos o mint da posição.
   */
  public async closeTokenAccount(
    mintAddress: string,
    destinationAddress?: string
  ): Promise<{ success: boolean; txSignature?: string | null; error?: string }> {
    if (!resolveExecutionMode(this.executionEnv).canBroadcast || !this.keypair) {
      return { success: false, txSignature: null, error: 'Shadow mode: rent closure blocked.' };
    }

    const mintPubkey = new PublicKey(mintAddress);
    const tokenProgramId = await this.resolveTokenProgram(mintPubkey);
    const ataAddress = getAssociatedTokenAddressSync(
      mintPubkey,
      this.keypair.publicKey,
      false,
      tokenProgramId
    );
    const result = await this.closeAccountAddress(
      ataAddress,
      destinationAddress,
      tokenProgramId
    );

    if (result.success) {
      console.log(`💰 [RentRecoveryService] ATA de ${mintAddress} encerrada. Tx: ${result.txSignature}`);
    } else {
      console.warn(`⚠️ [RentRecoveryService] Falha ao fechar ATA de ${mintAddress}: ${result.error}`);
    }
    return result;
  }

  /**
   * Varre contas SPL com saldo token = 0. Fecha a conta real retornada pelo RPC
   * (ATA ou conta SPL auxiliar) e soma os lamports efetivamente presentes nela.
   * Contas com qualquer saldo token são sempre preservadas.
   */
  public async sweepOrphanAccounts(destinationAddress?: string): Promise<SweepResult> {
    if (!resolveExecutionMode(this.executionEnv).canBroadcast || !this.keypair) {
      return {
        closedCount: 0,
        reclaimedSolEst: 0,
        reclaimedSolActual: 0,
        txSignatures: [],
        errors: []
      };
    }

    try {
      const accounts = await this.getParsedTokenAccountsForSupportedPrograms();

      let closedCount = 0;
      let reclaimedLamportsActual = 0;
      const txSignatures: string[] = [];
      const errors: string[] = [];

      for (const account of accounts) {
        const info = account.account.data.parsed?.info;
        if (!info) continue;

        const amountRaw = String(info.tokenAmount?.amount ?? '0');
        const mint = String(info.mint || '');
        // Nunca arredondar uiAmount para decidir fechamento. Só fecha amount atômico == 0.
        if (amountRaw !== '0' || !mint) continue;

        try {
          const rentLamports = Number(account.account.lamports || 0);
          const tokenProgramId = account.account.owner as PublicKey;
          const res = await this.closeAccountAddress(
            account.pubkey,
            destinationAddress,
            tokenProgramId
          );
          if (res.success && res.txSignature) {
            closedCount++;
            reclaimedLamportsActual += rentLamports;
            txSignatures.push(res.txSignature);
          } else if (res.error) {
            errors.push(`${mint}/${account.pubkey.toBase58()}: ${res.error}`);
          }
        } catch (e: any) {
          errors.push(`${mint}/${account.pubkey.toBase58()}: ${e?.message || e}`);
        }
      }

      const reclaimedSolEst = Number(
        (closedCount * RentRecoveryService.RENT_EXEMPTION_EST_SOL).toFixed(9)
      );
      const reclaimedSolActual = Number((reclaimedLamportsActual / 1e9).toFixed(9));

      if (closedCount > 0) {
        console.log(
          `🧹 [RentRecoveryService] ${closedCount} conta(s) SPL vazia(s) fechada(s). ` +
          `${reclaimedSolActual.toFixed(9)} SOL de rent observados on-chain foram devolvidos à carteira.`
        );
      }

      return { closedCount, reclaimedSolEst, reclaimedSolActual, txSignatures, errors };
    } catch (err: any) {
      const message = err?.message || String(err);
      console.warn(`⚠️ [RentRecoveryService] Erro ao varrer contas órfãs: ${message}`);
      return {
        closedCount: 0,
        reclaimedSolEst: 0,
        reclaimedSolActual: 0,
        txSignatures: [],
        errors: [message]
      };
    }
  }

  /** Varre todas as contas SPL com saldo > 0 da carteira. */
  public async getSplAccountsWithBalance(): Promise<SplAccountInfo[]> {
    if (!this.publicKey) return [];

    try {
      const parsedAccounts = await this.getParsedTokenAccountsForSupportedPrograms();

      const accounts: SplAccountInfo[] = [];
      for (const a of parsedAccounts) {
        const info = a.account.data.parsed?.info;
        if (!info) continue;

        const amountRaw = String(info.tokenAmount?.amount ?? '0');
        const amount = Number(info.tokenAmount?.uiAmount || 0);
        const mint = info.mint as string;
        const decimals = Number(info.tokenAmount?.decimals || 0);

        if (/^\d+$/.test(amountRaw) && BigInt(amountRaw) > 0n && mint) {
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
