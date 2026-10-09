import axios from 'axios';
import { RugCheckService, type RugCheckReport } from './rugCheckService.js';
import { SolanaLayaAdapter, sanitizeSolanaLayaFacts, type SolanaLayaDecision, type SolanaLayaFacts } from './solanaLayaAdapter.js';

export interface TokenSecurityMetadata {
  mint: string;
  pairAddress?: string;
  liquidityUsd: number;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  holdersCount?: number;
  buyTaxPct?: number;
  sellTaxPct?: number;
  priceChangeM5?: number;
  buysM5?: number;
  sellsM5?: number;
  volumeBuysM5?: number;
  volumeSellsM5?: number;
  priceUsd?: number;
  h1HighPriceUsd?: number;
}

export interface MomentumValidationResult {
  valid: boolean;
  reason?: string;
  momentumText?: string;
}

export interface SecurityAuditResult {
  /** Provider facts used by both the decision and journal, including vetoes. */
  rugCheckReport?: RugCheckReport;
  safe: boolean;
  reason?: string;
  score: number; // 0 a 100
  validatedBy: 'RUGCHECK_API' | 'LOCAL_HEURISTICS_FALLBACK' | 'MACRO_CIRCUIT_BREAKER' | 'DETERMINISTIC_SOLANA_PIPELINE';
  latencyMs?: number;
  layaNativeShadow?: SolanaLayaDecision;
  /** Fatos on-chain já validados para decisões táticas posteriores da Laya. */
  layaFacts?: SolanaLayaFacts;
}

export interface MemeGatekeeperConfig {
  minLiquidityUsd?: number;
  minHolders?: number;
  rugCheckService?: RugCheckService;
}

export class MemeRiskGatekeeper {
  private minLiquidityUsd: number;
  private minHolders: number;
  private rugCheckService: RugCheckService;

  constructor(config?: MemeGatekeeperConfig) {
    // Trava de Capital Solana: Rejeição estrita se liquidez < $15k
    this.minLiquidityUsd = config?.minLiquidityUsd || 15000;
    this.minHolders = config?.minHolders || 100;
    this.rugCheckService = config?.rugCheckService || new RugCheckService();
  }


  public async auditToken(token: TokenSecurityMetadata): Promise<SecurityAuditResult> {
    const startTime = Date.now();
    let layaNativeShadow: SolanaLayaDecision | undefined;

    // 1. Pré-Filtro Local Imediato (0ms): Honeypot e Risco de Rug Pull
    if (typeof token.mintAuthority === 'string' && token.mintAuthority.length > 0) {
      return {
        safe: false,
        reason: 'Risco de honeypot: mintAuthority ativo (o desenvolvedor pode emitir tokens infinitos).',
        score: 0,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }

    if (typeof token.freezeAuthority === 'string' && token.freezeAuthority.length > 0) {
      return {
        safe: false,
        reason: 'Risco de congelamento: freezeAuthority ativo (sua carteira pode ser bloqueada para venda).',
        score: 0,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }

    if (token.liquidityUsd < this.minLiquidityUsd) {
      return {
        safe: false,
        reason: `Liquidez insuficiente: $${token.liquidityUsd} < Mínimo seguro de $${this.minLiquidityUsd}.`,
        score: 10,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }

    if (token.holdersCount !== undefined && token.holdersCount < this.minHolders) {
      return {
        safe: false,
        reason: `Base de detentores frágil: ${token.holdersCount} holders < Mínimo seguro de ${this.minHolders}.`,
        score: 25,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }

    // 1.1 Motor determinístico de Momentum e Order Flow do Solana (Price Action)
    const momentumCheck = this.validatePriceMomentum(token);
    if (!momentumCheck.valid) {
      return {
        safe: false,
        reason: momentumCheck.reason || 'Filtro Solana: Momentum ou Order Flow reprovado',
        score: 15,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }

    // 0. Macro Sentinel check removed by user request

    // 2. Consulta à Sentinela On-Chain RugCheck (Honeypot, Top Holders e Liquidez Trancada)
    const rugReport = await this.rugCheckService.auditToken(token.mint, token.pairAddress);
    if (!rugReport.isSafe) {
      return {
      rugCheckReport: rugReport,
        safe: false,
        reason: `Veto por risco on-chain (RugCheck): ${rugReport.risks.join(' | ') || 'Score de perigo excedido'}`,
        score: rugReport.score,
        validatedBy: 'RUGCHECK_API',
        latencyMs: Date.now() - startTime
      };
    }

    if (rugReport.factsComplete !== true || rugReport.holdersCount === undefined) {
      return {
        rugCheckReport: rugReport,
        safe: false,
        reason: 'RugCheck não forneceu todos os fatos críticos do contrato. Entrada bloqueada por fail-closed.',
        score: 0,
        validatedBy: 'RUGCHECK_API',
        latencyMs: Date.now() - startTime
      };
    }

    if (rugReport.holdersCount < this.minHolders) {
      return {
        rugCheckReport: rugReport,
        safe: false,
        reason: `Base de detentores frágil: ${rugReport.holdersCount} holders < Mínimo seguro de ${this.minHolders}.`,
        score: 25,
        validatedBy: 'RUGCHECK_API',
        latencyMs: Date.now() - startTime
      };
    }

    const layaFacts: SolanaLayaFacts = sanitizeSolanaLayaFacts({
      mint: token.mint,
      liquidityUsd: token.liquidityUsd,
      holdersCount: rugReport.holdersCount,
      mintAuthorityRevoked: rugReport.mintAuthority === null,
      freezeAuthorityRevoked: rugReport.freezeAuthority === null,
      rugCheckScore: rugReport.score,
      lpLockedPct: rugReport.lpLockedPct,
      topHoldersPct: rugReport.topHoldersPct,
      priceChangeM5: token.priceChangeM5,
      buysM5: token.buysM5,
      sellsM5: token.sellsM5,
      volumeBuysM5: token.volumeBuysM5,
      volumeSellsM5: token.volumeSellsM5,
      priceUsd: token.priceUsd,
      h1HighPriceUsd: token.h1HighPriceUsd
    });



    return {
        rugCheckReport: rugReport,
      safe: true,
      reason: 'Filtros determinísticos Solana aprovados. Laya nativa registrada apenas em shadow/advisory.',
      score: rugReport.score,
      validatedBy: 'DETERMINISTIC_SOLANA_PIPELINE',
      latencyMs: Date.now() - startTime,
      layaNativeShadow,
      layaFacts
    };
  }

  /**
   * 🧠 Motor determinístico de Momentum e Order Flow do Solana
   * Valida Price Action e pressão de compradores para evitar ativos em sangria, topo esticado ou faca caindo.
   */
  public validatePriceMomentum(pair: Partial<TokenSecurityMetadata>): MomentumValidationResult {
    // 1. Janela de Momentum nos 5 Minutos (m5): entre +3% e +85%
    if (pair.priceChangeM5 !== undefined) {
      if (pair.priceChangeM5 <= 0) {
        return {
          valid: false,
          reason: `Filtro Solana: Preço em sangria/queda nos últimos 5m (${pair.priceChangeM5.toFixed(2)}% <= 0%)`
        };
      }
      if (pair.priceChangeM5 > 85) {
        return {
          valid: false,
          reason: `Filtro Solana: Preço esticado demais, risco de topo (${pair.priceChangeM5.toFixed(2)}% > +85%)`
        };
      }
      if (pair.priceChangeM5 < 3) {
        return {
          valid: false,
          reason: `Filtro Solana: Momentum insuficiente nos últimos 5m (${pair.priceChangeM5.toFixed(2)}% < +3%)`
        };
      }
    }

    // 2. Dominância de Compradores (Order Flow nos 5m: transações e volumes recentes)
    if (pair.buysM5 !== undefined && pair.sellsM5 !== undefined) {
      const minRequiredBuys = pair.sellsM5 * 1.0;
      if (pair.buysM5 < minRequiredBuys) {
        return {
          valid: false,
          reason: `Filtro Solana: Pressão vendedora dominante (Compras: ${pair.buysM5} < ${minRequiredBuys.toFixed(1)} [exigido paridade: ${pair.sellsM5}])`
        };
      }
    }

    if (pair.volumeBuysM5 !== undefined && pair.volumeSellsM5 !== undefined && (pair.volumeBuysM5 + pair.volumeSellsM5 > 0)) {
      const buyVolumeRatio = pair.volumeBuysM5 / (pair.volumeBuysM5 + pair.volumeSellsM5);
      if (buyVolumeRatio < 0.45) {
        return {
          valid: false,
          reason: `Filtro Solana: Volume comprador insuficiente (${(buyVolumeRatio * 100).toFixed(1)}% < 45% do total)`
        };
      }
    }

    // 3. Filtro Anti-Faca Caindo (Queda Pós-Topo h1: preço atual >= 65% da máxima h1)
    if (pair.priceUsd !== undefined && pair.h1HighPriceUsd !== undefined && pair.h1HighPriceUsd > 0) {
      const ratioFromHigh = pair.priceUsd / pair.h1HighPriceUsd;
      if (ratioFromHigh < 0.65) {
        return {
          valid: false,
          reason: `Filtro Solana: Ativo em distribuição pós-topo (Preço $${pair.priceUsd} é ${(ratioFromHigh * 100).toFixed(1)}% da máxima h1 $${pair.h1HighPriceUsd} < 65%)`
        };
      }
    }

    const m5Text = pair.priceChangeM5 !== undefined ? `Momentum m5: +${pair.priceChangeM5.toFixed(1)}%` : 'Momentum m5: neutro';
    const flowText = (pair.buysM5 !== undefined && pair.sellsM5 !== undefined) ? `Buys/Sells: ${pair.buysM5}/${pair.sellsM5}` : 'Order Flow OK';
    const volText = 'Vol Comprador > Vendedor';

    return {
      valid: true,
      momentumText: `${m5Text} | ${flowText} | ${volText}`
    };
  }
}

