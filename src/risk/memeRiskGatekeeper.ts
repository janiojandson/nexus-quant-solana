import axios from 'axios';
import { RugCheckService } from './rugCheckService.js';
import { SolanaLayaAdapter } from './solanaLayaAdapter.js';

export interface TokenSecurityMetadata {
  mint: string;
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
  safe: boolean;
  reason?: string;
  score: number; // 0 a 100
  validatedBy: 'AYLA_LAYA_ENGINE' | 'RUGCHECK_API' | 'LOCAL_HEURISTICS_FALLBACK' | 'MACRO_CIRCUIT_BREAKER';
  latencyMs?: number;
}

export interface MemeGatekeeperConfig {
  layaBaseUrl?: string;
  layaApiKey?: string;
  macroSentinelUrl?: string;
  timeoutMs?: number;
  minLiquidityUsd?: number;
  minHolders?: number;
  rugCheckService?: RugCheckService;
  solanaLayaAdapter?: SolanaLayaAdapter;
  layaNativeShadowEnabled?: boolean;
}

export class MemeRiskGatekeeper {
  private layaBaseUrl: string;
  private layaApiKey?: string;
  private macroSentinelUrl: string;
  private timeoutMs: number;
  private minLiquidityUsd: number;
  private minHolders: number;
  private rugCheckService: RugCheckService;
  private solanaLayaAdapter: SolanaLayaAdapter;
  private layaNativeShadowEnabled: boolean;

  constructor(config?: MemeGatekeeperConfig) {
    // Malha interna do Railway ou URL configurada
    this.layaBaseUrl = config?.layaBaseUrl || process.env.LAYA_INTERNAL_URL || 'http://nexus-decisor-laya.railway.internal:8000';
    this.layaApiKey = config?.layaApiKey || process.env.LAYA_API_KEY;
    this.macroSentinelUrl = config?.macroSentinelUrl || process.env.MACRO_SENTINEL_URL || 'http://nexus-macro-sentinel.railway.internal:4005';
    // Tolerância estendida de latência para a CPU da Ayla (padrão 4000ms para acomodar 800ms-1500ms com folga)
    this.timeoutMs = config?.timeoutMs || 4000;
    // Trava de Capital Ayla: Rejeição estrita se liquidez < $15k
    this.minLiquidityUsd = config?.minLiquidityUsd || 15000;
    this.minHolders = config?.minHolders || 100;
    this.rugCheckService = config?.rugCheckService || new RugCheckService();
    this.solanaLayaAdapter = config?.solanaLayaAdapter || new SolanaLayaAdapter();
    this.layaNativeShadowEnabled = config?.layaNativeShadowEnabled
      ?? process.env.SOLANA_LAYA_SHADOW_ENABLED === 'true';
  }

  public async checkMacroCircuitBreaker(): Promise<{ isBreakerActive: boolean; regime?: string }> {
    try {
      const res = await axios.get(`${this.macroSentinelUrl}/v1/sentinel/regime`, {
        timeout: 2500
      });
      if (typeof res.data?.is_circuit_breaker_active !== 'boolean') {
        return { isBreakerActive: true, regime: 'INVALID_SENTINEL_RESPONSE' };
      }
      return {
        isBreakerActive: res.data.is_circuit_breaker_active,
        regime: typeof res.data?.regime === 'string' ? res.data.regime : 'UNKNOWN'
      };
    } catch {
      // Fail-closed: sem estado confi?vel do Sentinel, nenhuma nova entrada ? permitida.
      return { isBreakerActive: true, regime: 'SENTINEL_UNAVAILABLE' };
    }
  }

  public async auditToken(token: TokenSecurityMetadata): Promise<SecurityAuditResult> {
    const startTime = Date.now();

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

    if (rugReport.factsComplete !== true || rugReport.holdersCount === undefined) {
      return {
        safe: false,
        reason: 'RugCheck não forneceu todos os fatos críticos do contrato. Entrada bloqueada por fail-closed.',
        score: 0,
        validatedBy: 'RUGCHECK_API',
        latencyMs: Date.now() - startTime
      };
    }

    if (rugReport.holdersCount < this.minHolders) {
      return {
        safe: false,
        reason: `Base de detentores frágil: ${rugReport.holdersCount} holders < Mínimo seguro de ${this.minHolders}.`,
        score: 25,
        validatedBy: 'RUGCHECK_API',
        latencyMs: Date.now() - startTime
      };
    }

    if (this.layaNativeShadowEnabled) {
      try {
        const shadow = await this.solanaLayaAdapter.evaluate({
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
        console.log(
          `[LayaNative:SHADOW] mint=${token.mint} action=${shadow.action} ` +
          `confidence=${shadow.actionConfidence.toFixed(4)} risk=${shadow.residualRiskScore ?? 'n/a'} ` +
          `review=${shadow.needsDeeperReview ?? 'n/a'} model=${shadow.routingModel ?? 'n/a'} ` +
          `latencyMs=${shadow.latencyMs}`
        );
      } catch (shadowErr: any) {
        console.warn(`[LayaNative:SHADOW] falha sem impacto na decisão: ${shadowErr?.message || shadowErr}`);
      }
    }

    // 3. Consulta à Ayla/Laya (Decisão Reflexiva com timeout tolerante de até 4000ms)
    // Padrão: malha interna do Railway (sem custo de egressa, latência mínima).
    // Fallback: URL pública via internet, apenas se a interna falhar por DNS/conexão.
    const internalUrl = this.layaBaseUrl;
    const publicUrl = process.env.LAYA_PUBLIC_FALLBACK_URL
      || 'https://nexus-decisor-laya-production.up.railway.app';

    const layaPayload = {
      state: {
        context: 'SOLANA_MEMECOIN_AUDIT',
        targetMint: token.mint,
        liquidityUsd: token.liquidityUsd,
        holdersCount: rugReport.holdersCount,
        mintAuthority: rugReport.mintAuthority ?? null,
        freezeAuthority: rugReport.freezeAuthority ?? null,
        rugCheckScore: rugReport.score,
        lpLockedPct: rugReport.lpLockedPct,
        topHoldersPct: rugReport.topHoldersPct,
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
    };

    const layaRequestConfig = {
      timeout: this.timeoutMs,
      headers: this.layaApiKey ? { 'x-laya-key': this.layaApiKey } : undefined
    };

    let response;
    try {
      response = await axios.post(`${internalUrl}/v1/systemone`, layaPayload, layaRequestConfig);
    } catch (firstErr: any) {
      // Timeout não tenta fallback: a Laya pode estar processando.
      const isTimeout = firstErr?.code === 'ECONNABORTED' || firstErr?.message?.includes('timeout');
      if (isTimeout) throw firstErr;

      try {
        console.warn(`[Ayla/Laya] Malha interna ${internalUrl} falhou (${firstErr?.message || firstErr}). Tentando fallback público...`);
        response = await axios.post(`${publicUrl}/v1/systemone`, layaPayload, layaRequestConfig);
        console.warn(`[Ayla/Laya] Resposta via fallback público (${publicUrl})`);
      } catch (publicErr: any) {
        console.warn(`[Ayla/Laya] Fallback público também falhou (${publicErr?.message || publicErr}). Usando heurísticas locais.`);
      }
    }

    try {
      if (!response) {
        throw new Error('Laya indisponível: ambas as rotas (interna e pública) falharam');
      }

      const decision = response.data;
      const latencyMs = Date.now() - startTime;

      // O Laya retorna { success, answers: { action: { choice, verdict, rationale } }, verdict, rationale_code, routing }
      // O VETO pode estar em `verdict` (top-level) ou em `answers.action.choice`
      const vetoChoice = decision?.answers?.action?.choice ?? decision?.verdict;
      const normalizedChoice = typeof vetoChoice === 'string' ? vetoChoice.trim().toUpperCase() : '';
      const isVeto = normalizedChoice === 'VETO';

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

      const explicitApproval = ['ALLOW', 'APPROVE', 'BUY', 'PROCEED', 'SAFE', 'ACCEPT'].includes(normalizedChoice);
      if (!explicitApproval) {
        return {
          safe: false,
          reason: `Resposta da Ayla/Laya sem aprova??o expl?cita (${normalizedChoice || 'ausente'}). Entrada bloqueada por fail-closed.`,
          score: 0,
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
    } catch (err: any) {
      // Fail-closed: falha, timeout ou resposta inv?lida da Ayla n?o autorizam compra.
      return {
        safe: false,
        reason: `Ayla/Laya indispon?vel ou resposta inv?lida: ${err?.message || 'erro desconhecido'}. Entrada bloqueada.`,
        score: 0,
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

