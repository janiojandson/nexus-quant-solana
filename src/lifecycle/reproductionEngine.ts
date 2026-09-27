import { Keypair } from '@solana/web3.js';

export type ChildSpecialty = 'LEAD_GENERATOR' | 'MEME_HUNTER' | 'X_INFLUENCER' | 'YOUTUBE_CREATOR';

export interface SurplusSplitParams {
  currentBalanceSol: number;
  reserveOperatingBalanceSol: number;
}

export interface SurplusSplitResult {
  surplusTotalSol: number;
  profitShareJanioSol: number;
  childInitialStakeSol: number;
}

export interface ChildAgentRecord {
  childPublicKey: string;
  specialty: ChildSpecialty;
  status: 'SPAWNED' | 'ACTIVE';
  spawnedAt: string;
}

export class ReproductionEngine {
  public static readonly REPRODUCTION_THRESHOLD_SOL = 0.50; // Gatilho de prosperidade
  public static readonly DEFAULT_OPERATING_RESERVE_SOL = 0.20; // Capital mantido pelo agente pai

  public canReproduce(currentBalanceSol: number): boolean {
    return currentBalanceSol >= ReproductionEngine.REPRODUCTION_THRESHOLD_SOL;
  }

  public calculateSurplusSplit(params: SurplusSplitParams): SurplusSplitResult {
    const surplus = Math.max(0, params.currentBalanceSol - params.reserveOperatingBalanceSol);
    const half = Number((surplus / 2).toFixed(4));

    return {
      surplusTotalSol: Number(surplus.toFixed(4)),
      profitShareJanioSol: half,
      childInitialStakeSol: half
    };
  }

  public async spawnChildAgent(specialty: ChildSpecialty): Promise<ChildAgentRecord> {
    const childKeypair = Keypair.generate();

    return {
      childPublicKey: childKeypair.publicKey.toBase58(),
      specialty,
      status: 'SPAWNED',
      spawnedAt: new Date().toISOString()
    };
  }
}
