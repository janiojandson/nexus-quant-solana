export enum TokenCategory {
  BASE_INFRASTRUCTURE = 'BASE_INFRASTRUCTURE', // SOL, USDC, USDT, etc.
  MICRO_CAP_MEME = 'MICRO_CAP_MEME',           // $5k - $50k Liq
  MID_CAP_MEME = 'MID_CAP_MEME',               // $50k - $500k Liq
  ESTABLISHED_TOKEN = 'ESTABLISHED_TOKEN'       // > $500k Liq
}

export interface ClassificationResult {
  category: TokenCategory;
  isEligibleForMemeScan: boolean;
  reason?: string;
}

export class TokenClassifier {
  // Mints oficiais de infraestrutura e tokens base que nunca devem ser tratados como memecoins
  private static readonly BASE_MINTS = new Set<string>([
    'So11111111111111111111111111111111111111112', // Wrapped SOL
    'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
    'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
    '97owM7j5K2ciCKjh1Efi8ix8Et9Tp7sjgnmLM2CHMamN', // Falso SOL / Par wrapper
    'mSoLzYCIlBmHd67vP8bK4g2VDU528v5ULWB7v6NWdTY', // Marinade SOL
    'bSo13r4TkiE4KumL71LsHTPpL2euBYLFx6h9HP3piy1', // BlazeStake SOL
    'J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn'  // Jito SOL
  ]);

  private static readonly BASE_SYMBOLS = new Set<string>([
    'SOL', 'WSOL', 'USDC', 'USDT', 'USD', 'MSOL', 'BSOL', 'JITOSOL'
  ]);

  public static classify(mint: string, symbol: string, liquidityUsd: number): ClassificationResult {
    const upperSymbol = (symbol || '').toUpperCase().trim();

    if (this.BASE_MINTS.has(mint) || this.BASE_SYMBOLS.has(upperSymbol)) {
      return {
        category: TokenCategory.BASE_INFRASTRUCTURE,
        isEligibleForMemeScan: false,
        reason: 'Ativo de infraestrutura/base (não é memecoin especulativa).'
      };
    }

    if (liquidityUsd < 50000) {
      return {
        category: TokenCategory.MICRO_CAP_MEME,
        isEligibleForMemeScan: true
      };
    }

    if (liquidityUsd <= 500000) {
      return {
        category: TokenCategory.MID_CAP_MEME,
        isEligibleForMemeScan: true
      };
    }

    return {
      category: TokenCategory.ESTABLISHED_TOKEN,
      isEligibleForMemeScan: true
    };
  }
}

export class AntiSpamMemory {
  // Mapa de Mints já analisados -> timestamp de expiração e expiração personalizada
  private vettedTokens = new Map<string, { timestamp: number; reason: string; expiresAt: number }>();
  private approvedTokens = new Map<string, { timestamp: number; score: number }>();
  private defaultTtlMs: number;

  constructor(ttlMinutes: number = 60) {
    this.defaultTtlMs = ttlMinutes * 60 * 1000;
  }

  public shouldSkip(mint: string): { skip: boolean; reason?: string } {
    const now = Date.now();

    // Checa veto recente
    const veto = this.vettedTokens.get(mint);
    if (veto) {
      if (now < veto.expiresAt) {
        const remainingHours = Math.ceil((veto.expiresAt - now) / (60 * 60 * 1000));
        return { skip: true, reason: `Em quarentena (${remainingHours}h restantes): ${veto.reason}` };
      }
      this.vettedTokens.delete(mint);
    }

    // Checa aprovação recente
    const approved = this.approvedTokens.get(mint);
    if (approved) {
      if (now - approved.timestamp < this.defaultTtlMs) {
        return { skip: true, reason: `Já auditado e aprovado recentemente com Score ${approved.score}/100.` };
      }
      this.approvedTokens.delete(mint);
    }

    return { skip: false };
  }

  public recordVeto(mint: string, reason: string, customTtlMs?: number): void {
    const now = Date.now();
    const expiresAt = now + (customTtlMs !== undefined ? customTtlMs : this.defaultTtlMs);
    this.vettedTokens.set(mint, { timestamp: now, reason, expiresAt });
  }

  public recordApproval(mint: string, score: number): void {
    this.approvedTokens.set(mint, { timestamp: Date.now(), score });
  }

  public getStats(): { vettedCount: number; approvedCount: number } {
    return {
      vettedCount: this.vettedTokens.size,
      approvedCount: this.approvedTokens.size
    };
  }
}
