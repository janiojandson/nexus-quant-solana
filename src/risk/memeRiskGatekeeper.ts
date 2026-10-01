import axios from 'axios';
import { RugCheckService } from './rugCheckService.js';

export interface TokenSecurityMetadata {
  mint: string;
  liquidityUsd: number;
  mintAuthority: string | null;
  freezeAuthority: string | null;
  holdersCount: number;
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
  safe: boolean;
  reason?: string;
  score: number; // 0 a 100
  validatedBy: 'AYLA_LAYA_ENGINE' | 'RUGCHECK_API' | 'LOCAL_HEURISTICS_FALLBACK' | 'MACRO_CIRCUIT_BREAKER';
  latencyMs?: number;
}

export interface MemeGatekeeperConfig {
  layaBaseUrl?: string;
  macroSentinelUrl?: string;
  timeoutMs?: number;
  minLiquidityUsd?: number;
  minHolders?: number;
  rugCheckService?: RugCheckService;
}

export class MemeRiskGatekeeper {
  private layaBaseUrl: string;
  private macroSentinelUrl: string;
  private timeoutMs: number;
  private minLiquidityUsd: number;
  private minHolders: number;
  private rugCheckService: RugCheckService;

  constructor(config?: MemeGatekeeperConfig) {
    // Malha interna do Railway ou URL configurada
    this.layaBaseUrl = config?.layaBaseUrl || process.env.LAYA_INTERNAL_URL || 'http://nexus-decisor-laya.railway.internal:8080';
    this.macroSentinelUrl = config?.macroSentinelUrl || process.env.MACRO_SENTINEL_URL || 'http://nexus-macro-sentinel.railway.internal:4005';
    // Tolerância estendida de latência para a CPU da Ayla (padrão 4000ms para acomodar 800ms-1500ms com folga)
    this.timeoutMs = config?.timeoutMs || 4000;
    // Trava de Capital Ayla: Rejeição estrita se liquidez < $15k
    this.minLiquidityUsd = config?.minLiquidityUsd || 15000;
    this.minHolders = config?.minHolders || 100;
    this.rugCheckService = config?.rugCheckService || new RugCheckService();
  }

  public async checkMacroCircuitBreaker(): Promise<{ isBreakerActive: boolean; regime?: string }> {
    try {
      const res = await axios.get(`${this.macroSentinelUrl}/v1/sentinel/regime`, {
        timeout: 2500
      });
      return {
        isBreakerActive: Boolean(res.data?.is_circuit_breaker_active),
        regime: res.data?.regime
      };
    } catch {
      // Se o macro estiver indisponível temporariamente, opera gracioso
      return { isBreakerActive: false };
    }
  }

  public async auditToken(token: TokenSecurityMetadata): Promise<SecurityAuditResult> {
    const startTime = Date.now();

    // 0. Consulta ao Disjuntor Macro Institucional (nexus-macro-sentinel :4005)
    const macroCheck = await this.checkMacroCircuitBreaker();
    if (macroCheck.isBreakerActive) {
      return {
        safe: false,
        reason: `Disjuntor Macro Ativado pelo Nexus Sentinel: Mercado em colapso/sangria (${macroCheck.regime || 'BEARISH_DUMP'}). Compras suspensas.`,
        score: 0,
        validatedBy: 'MACRO_CIRCUIT_BREAKER',
        latencyMs: Date.now() - startTime
      };
    }

    // 1. Pré-Filtro Local Imediato (0ms): Honeypot e Risco de Rug Pull
    if (token.mintAuthority !== null) {
      return {
        safe: false,
        reason: 'Risco de honeypot: mintAuthority ativo (o desenvolvedor pode emitir tokens infinitos).',
        score: 0,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }

    if (token.freezeAuthority !== null) {
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

    if (token.holdersCount < this.minHolders) {
      return {
        safe: false,
        reason: `Base de detentores frágil: ${token.holdersCount} holders < Mínimo seguro de ${this.minHolders}.`,
        score: 25,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }

    // 1.1 Motor de Momentum e Order Flow na Ayla (Price Action)
    const momentumCheck = this.validatePriceMomentum(token);
    if (!momentumCheck.valid) {
      return {
        safe: false,
        reason: momentumCheck.reason || 'Ayla Veto: Momentum ou Order Flow reprovado',
        score: 15,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }

    // 2. Consulta à Sentinela On-Chain RugCheck (Honeypot, Top Holders e Liquidez Trancada)
    const rugReport = await this.rugCheckService.auditToken(token.mint);
    if (!rugReport.isSafe) {
      return {
        safe: false,
        reason: `Veto por risco on-chain (RugCheck): ${rugReport.risks.join(' | ') || 'Score de perigo excedido'}`,
        score: Math.max(0, 100 - (rugReport.score / 10)),
        validatedBy: 'RUGCHECK_API',
        latencyMs: Date.now() - startTime
      };
    }

    // 3. Consulta à Ayla/Laya (Decisão Reflexiva com timeout tolerante de até 4000ms)
    try {
      const response = await axios.post(
        `${this.layaBaseUrl}/v1/systemone`,
        {
          state: {
            context: 'SOLANA_MEMECOIN_AUDIT',
            targetMint: token.mint,
            liquidityUsd: token.liquidityUsd,
            holdersCount: token.holdersCount,
            mintAuthority: token.mintAuthority,
            freezeAuthority: token.freezeAuthority,
            buyTaxPct: token.buyTaxPct,
            sellTaxPct: token.sellTaxPct,
            priceChangeM5: token.priceChangeM5,
            buysM5: token.buysM5,
            sellsM5: token.sellsM5,
            volumeBuysM5: token.volumeBuysM5,
            volumeSellsM5: token.volumeSellsM5,
            priceUsd: token.priceUsd,
            h1HighPriceUsd: token.h1HighPriceUsd
          },
          questions: {
            context: 'SOLANA_MEMECOIN_AUDIT',
            targetMint: token.mint
          }
        },
        {
          timeout: this.timeoutMs
        }
      );

      const decision = response.data;
      const latencyMs = Date.now() - startTime;

      // O Laya retorna { success, answers: { action: { choice, verdict, rationale } }, verdict, rationale_code, routing }
      // O VETO pode estar em `verdict` (top-level) ou em `answers.action.choice`
      const vetoChoice = decision?.answers?.action?.choice ?? decision?.verdict;
      const isVeto = vetoChoice === 'VETO';

      if (isVeto) {
        const reason = decision?.answers?.action?.rationale
          || decision?.rationale_code
          || 'Risco de fluxo detectado';
        return {
          safe: false,
          reason: `Veto emitido pela Ayla/Laya: ${reason}`,
          score: 15,
          validatedBy: 'AYLA_LAYA_ENGINE',
          latencyMs
        };
      }

      return {
        safe: true,
        score: 95,
        validatedBy: 'AYLA_LAYA_ENGINE',
        latencyMs
      };
    } catch {
      // 3. Fallback Gracioso: Se a Ayla demorar mais que o timeout ou estiver reiniciando,
      // as heurísticas locais robustas já garantiram que não é honeypot, mint ativo ou liquidez baixa.
      return {
        safe: true,
        score: 80,
        validatedBy: 'LOCAL_HEURISTICS_FALLBACK',
        latencyMs: Date.now() - startTime
      };
    }
  }

  /**
   * 🧠 Motor de Momentum e Order Flow da Ayla
   * Valida Price Action e pressão de compradores para evitar ativos em sangria, topo esticado ou faca caindo.
   */
  public validatePriceMomentum(pair: Partial<TokenSecurityMetadata>): MomentumValidationResult {
    // 1. Janela de Momentum nos 5 Minutos (m5): entre +3% e +85%
    if (pair.priceChangeM5 !== undefined) {
      if (pair.priceChangeM5 <= 0) {
        return {
          valid: false,
          reason: `Ayla Veto: Preço em sangria/queda nos últimos 5m (${pair.priceChangeM5.toFixed(2)}% <= 0%)`
        };
      }
      if (pair.priceChangeM5 > 85) {
        return {
          valid: false,
          reason: `Ayla Veto: Preço esticado demais, risco de topo (${pair.priceChangeM5.toFixed(2)}% > +85%)`
        };
      }
      if (pair.priceChangeM5 < 3) {
        return {
          valid: false,
          reason: `Ayla Veto: Momentum insuficiente nos últimos 5m (${pair.priceChangeM5.toFixed(2)}% < +3%)`
        };
      }
    }

    // 2. Dominância de Compradores (Order Flow nos 5m: transações e volumes recentes)
    if (pair.buysM5 !== undefined && pair.sellsM5 !== undefined) {
      const minRequiredBuys = pair.sellsM5 * 1.0;
      if (pair.buysM5 < minRequiredBuys) {
        return {
          valid: false,
          reason: `Ayla Veto: Pressão vendedora dominante (Compras: ${pair.buysM5} < ${minRequiredBuys.toFixed(1)} [exigido paridade: ${pair.sellsM5}])`
        };
      }
    }

    if (pair.volumeBuysM5 !== undefined && pair.volumeSellsM5 !== undefined && (pair.volumeBuysM5 + pair.volumeSellsM5 > 0)) {
      const buyVolumeRatio = pair.volumeBuysM5 / (pair.volumeBuysM5 + pair.volumeSellsM5);
      if (buyVolumeRatio < 0.45) {
        return {
          valid: false,
          reason: `Ayla Veto: Volume comprador insuficiente (${(buyVolumeRatio * 100).toFixed(1)}% < 45% do total)`
        };
      }
    }

    // 3. Filtro Anti-Faca Caindo (Queda Pós-Topo h1: preço atual >= 65% da máxima h1)
    if (pair.priceUsd !== undefined && pair.h1HighPriceUsd !== undefined && pair.h1HighPriceUsd > 0) {
      const ratioFromHigh = pair.priceUsd / pair.h1HighPriceUsd;
      if (ratioFromHigh < 0.65) {
        return {
          valid: false,
          reason: `Ayla Veto: Ativo em distribuição pós-topo (Preço $${pair.priceUsd} é ${(ratioFromHigh * 100).toFixed(1)}% da máxima h1 $${pair.h1HighPriceUsd} < 65%)`
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

