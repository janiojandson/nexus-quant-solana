import axios from 'axios';

export type SolanaLayaRoute = 'MECHANICAL_PIPELINE' | 'DEEP_REVIEW' | 'ABSTAIN';
export type SolanaLayaEntryAction = 'BUY' | 'WAIT' | 'ABSTAIN' | 'REJECT' | 'VETO';
export type SolanaLayaPositionAction = 'HOLD' | 'EXIT' | 'ABSTAIN';
export type SolanaLayaTacticalMode = 'OFF' | 'SHADOW' | 'LIVE';

export function normalizeSolanaLayaTacticalMode(value: unknown): SolanaLayaTacticalMode {
  const normalized = String(value || 'LIVE').trim().toUpperCase();
  if (normalized === 'OFF') return 'OFF';
  if (normalized === 'SHADOW') return 'SHADOW';
  return 'LIVE';
}

export interface SolanaLayaGateResult {
  blocked: boolean;
  reason?: string;
  score: number;
}

export function shouldBlockSolanaEntryFromLaya(
  decision: { action: string; confidence?: number; score?: number } | string,
  mode: SolanaLayaTacticalMode = 'LIVE'
): SolanaLayaGateResult {
  if (mode !== 'LIVE') {
    return { blocked: false, score: 100 };
  }

  const action = typeof decision === 'string' ? decision : decision.action;
  const confidence = typeof decision === 'string' ? 1.0 : (decision.confidence ?? 1.0);
  const score = typeof decision === 'string'
    ? 100
    : (decision.score !== undefined ? decision.score : Math.round(confidence * 100));

  if (action === 'REJECT' || action === 'VETO') {
    return {
      blocked: true,
      reason: `Veto por IA Laya Sentinel (Score ${score} < 75)`,
      score
    };
  }

  if (score < 75) {
    return {
      blocked: true,
      reason: `Veto por IA Laya Sentinel (Score ${score} < 75)`,
      score
    };
  }

  if (action === 'WAIT') {
    return {
      blocked: true,
      reason: `Veto por IA Laya Sentinel (Ação WAIT / Score ${score})`,
      score
    };
  }

  if (action === 'ABSTAIN') {
    return {
      blocked: true,
      reason: `Veto por IA Laya Sentinel (Score ${score} < 75)`,
      score
    };
  }

  return { blocked: false, score };
}

export interface SolanaLayaFacts {
  mint: string;
  liquidityUsd: number;
  holdersCount: number;
  mintAuthorityRevoked: boolean;
  freezeAuthorityRevoked: boolean;
  rugCheckScore: number;
  lpLockedPct?: number;
  topHoldersPct?: number;
  priceChangeM5?: number;
  buysM5?: number;
  sellsM5?: number;
  volumeBuysM5?: number;
  volumeSellsM5?: number;
  priceUsd?: number;
  h1HighPriceUsd?: number;
  symbol?: string;
  liquidity?: number;
  volume5m?: number;
  volume5mUsd?: number;
  priceChange?: number;
  holders?: number;
  devShare?: number;
  devSharePercent?: number;
  holderDistribution?: number;
  topHoldersShare?: number;
  score?: number;
}

export interface SolanaLayaPositionFacts {
  mint: string;
  symbol?: string;
  pnlPct: number;
  peakPnlPct: number;
  holdingSeconds: number;
  partialTaken: boolean;
  currentPriceUsd?: number;
  entryPriceUsd: number;
  lastKnownLiquidityUsd?: number;
  lastKnownVolume5mUsd?: number;
  buySellRatio?: number;
  trailingActive?: boolean;
  stopLossPct?: number;
  liquidityUsd?: number;
  volume5mUsd?: number;
}

export function extractLayaErrorMessage(error: any): string {
  if (error?.response?.data) {
    const data = error.response.data;
    if (typeof data === 'string') return data;
    if (data.detail) {
      if (typeof data.detail === 'string') return data.detail;
      if (Array.isArray(data.detail)) {
        return data.detail
          .map((d: any) => {
            const loc = Array.isArray(d.loc) ? d.loc.join('.') : (d.loc || '');
            const msg = d.msg || d.message || JSON.stringify(d);
            return loc ? `${loc}: ${msg}` : msg;
          })
          .join(' | ');
      }
      return JSON.stringify(data.detail);
    }
    if (data.error) {
      return typeof data.error === 'string' ? data.error : JSON.stringify(data.error);
    }
    if (data.message) {
      return typeof data.message === 'string' ? data.message : JSON.stringify(data.message);
    }
    try {
      return JSON.stringify(data);
    } catch {
      return String(data);
    }
  }
  return error?.message || String(error);
}

export function sanitizeSolanaLayaFacts(raw: Partial<SolanaLayaFacts> | Record<string, any> | undefined | null): SolanaLayaFacts & Record<string, any> {
  const f: Record<string, any> = (raw || {}) as Record<string, any>;
  const num = (v: any, fallback = 0): number => {
    if (v === null || v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const bool = (v: any, fallback = false): boolean => {
    if (typeof v === 'boolean') return v;
    if (v === 'true' || v === 1) return true;
    if (v === 'false' || v === 0) return false;
    return fallback;
  };
  const str = (v: any, fallback = ''): string => {
    if (typeof v === 'string') return v.trim();
    if (v === null || v === undefined) return fallback;
    return String(v).trim();
  };

  const mint = str(f.mint || f.tokenAddress || f.address, 'UNKNOWN_MINT');
  const symbol = str(f.symbol || f.tokenSymbol, 'UNKNOWN');
  const liquidityUsd = Math.max(0, num(f.liquidityUsd ?? f.liquidity, 0));
  const volume5mUsd = Math.max(0, num(f.volume5mUsd ?? f.volume5m, 0));
  const priceChangeM5 = num(f.priceChangeM5 ?? f.priceChange5mPct ?? f.priceChange, 0);
  const holdersCount = Math.max(0, Math.round(num(f.holdersCount ?? f.holders, 0)));
  const rugCheckScore = Math.max(0, Math.min(100, Math.round(num(f.rugCheckScore ?? f.score, 0))));
  const devShare = Math.max(0, num(f.devShare ?? f.devSharePercent ?? f.dev_share, 0));
  const topHoldersPct = Math.max(0, num(f.topHoldersPct ?? f.topHoldersShare ?? f.top5HoldersPct ?? f.holderDistribution, 0));
  const lpLockedPct = Math.max(0, Math.min(100, num(f.lpLockedPct ?? f.lp_locked_pct, 0)));
  const buysM5 = Math.max(0, Math.round(num(f.buysM5 ?? f.buysCount5m, 0)));
  const sellsM5 = Math.max(0, Math.round(num(f.sellsM5 ?? f.sellsCount5m, 0)));
  const volumeBuysM5 = Math.max(0, num(f.volumeBuysM5, 0));
  const volumeSellsM5 = Math.max(0, num(f.volumeSellsM5, 0));
  const priceUsd = Math.max(0, num(f.priceUsd, 0));
  const h1HighPriceUsd = Math.max(0, num(f.h1HighPriceUsd, priceUsd));

  return {
    mint,
    symbol,
    liquidityUsd,
    liquidity: liquidityUsd,
    volume5mUsd,
    volume5m: volume5mUsd,
    priceChangeM5,
    priceChange: priceChangeM5,
    holdersCount,
    holders: holdersCount,
    holderDistribution: topHoldersPct,
    devShare,
    devSharePercent: devShare,
    topHoldersPct,
    topHoldersShare: topHoldersPct,
    rugCheckScore,
    score: rugCheckScore,
    mintAuthorityRevoked: bool(f.mintAuthorityRevoked, false),
    freezeAuthorityRevoked: bool(f.freezeAuthorityRevoked, false),
    lpLockedPct,
    buysM5,
    sellsM5,
    volumeBuysM5,
    volumeSellsM5,
    priceUsd,
    h1HighPriceUsd
  };
}

export function sanitizeSolanaLayaPositionFacts(raw: Partial<SolanaLayaPositionFacts> | undefined | null): SolanaLayaPositionFacts & Record<string, any> {
  const f = raw || {};
  const num = (v: any, fallback = 0): number => {
    if (v === null || v === undefined) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  };
  const str = (v: any, fallback = ''): string => {
    if (typeof v === 'string') return v.trim();
    if (v === null || v === undefined) return fallback;
    return String(v).trim();
  };

  const mint = str(f.mint, 'UNKNOWN_MINT');
  const symbol = str(f.symbol, 'UNKNOWN');
  const pnlPct = num(f.pnlPct, 0);
  const peakPnlPct = num(f.peakPnlPct, pnlPct);
  const holdingSeconds = Math.max(0, Math.round(num(f.holdingSeconds, 0)));
  const partialTaken = Boolean(f.partialTaken);
  const entryPriceUsd = num(f.entryPriceUsd, 0);
  const currentPriceUsd = num(f.currentPriceUsd, entryPriceUsd);
  const lastKnownLiquidityUsd = Math.max(0, num(f.lastKnownLiquidityUsd, 0));
  const lastKnownVolume5mUsd = Math.max(0, num(f.lastKnownVolume5mUsd, 0));
  const buySellRatio = num(f.buySellRatio, 1.0);
  const trailingActive = Boolean(f.trailingActive);
  const stopLossPct = num(f.stopLossPct, -0.15);

  return {
    mint,
    symbol,
    pnlPct,
    peakPnlPct,
    holdingSeconds,
    partialTaken,
    currentPriceUsd,
    entryPriceUsd,
    lastKnownLiquidityUsd,
    liquidityUsd: lastKnownLiquidityUsd,
    lastKnownVolume5mUsd,
    volume5mUsd: lastKnownVolume5mUsd,
    buySellRatio,
    trailingActive,
    stopLossPct
  };
}

export interface SolanaLayaDecision {
  route: SolanaLayaRoute;
  routeConfidence: number;
  /** Legacy telemetry fields retained only for backward-compatible readers. */
  residualRiskScore?: number;
  residualRiskConfidence?: number;
  needsLlm?: number;
  needsLlmConfidence?: number;
  abstention?: string;
  lowConfidence?: boolean;
  routingModel?: string;
  latencyMs: number;
  raw?: unknown;
}

export interface SolanaLayaTacticalDecision<TAction extends string> {
  action: TAction;
  confidence: number;
  score?: number;
  abstention?: string;
  lowConfidence?: boolean;
  routingModel?: string;
  latencyMs: number;
  raw?: unknown;
}

export interface SolanaLayaAdapterOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
  privateProxy?: boolean;
  httpClient?: typeof axios;
}

interface ChoiceRequest<TAction extends string> {
  facts: unknown;
  contractVersion: string;
  stage: string;
  body: string;
  questionName: string;
  instructions: string;
  criteria: Record<TAction, string>;
  allowed: readonly TAction[];
  minConfidence: number;
}

export class SolanaLayaAdapter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly privateProxy: boolean;
  private readonly httpClient: typeof axios;

  constructor(options: SolanaLayaAdapterOptions = {}) {
    this.baseUrl = options.baseUrl || process.env.SOLANA_LAYA_NATIVE_URL || '';
    this.apiKey = options.apiKey || process.env.SOLANA_LAYA_AUTH_TOKEN || process.env.SOLANA_LAYA_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.SOLANA_LAYA_TIMEOUT_MS || 2500);
    this.privateProxy = options.privateProxy
      ?? (process.env.SOLANA_LAYA_PRIVATE_PROXY === 'true'
        || this.baseUrl.includes('.railway.internal:8001'));
    this.httpClient = options.httpClient || axios;
  }

  private assertConfigured(): void {
    if (!this.baseUrl) throw new Error('SOLANA_LAYA_NATIVE_URL ausente para contrato nativo');
    if (!this.privateProxy && !this.apiKey) throw new Error('Credencial Laya ausente para endpoint público');
  }

  private async askChoice<TAction extends string>(
    request: ChoiceRequest<TAction>
  ): Promise<SolanaLayaTacticalDecision<TAction>> {
    this.assertConfigured();

    const sanitizedFacts =
      request.facts && typeof request.facts === 'object' && 'holdingSeconds' in request.facts
        ? sanitizeSolanaLayaPositionFacts(request.facts as any)
        : sanitizeSolanaLayaFacts(request.facts as any);

    const contextData = {
      ...sanitizedFacts,
      source: 'nexus-quant-solana',
      contractVersion: request.contractVersion,
      stage: request.stage
    };

    const payload = {
      state: {
        body: request.body,
        domain: 'solana_memecoin',
        contractVersion: request.contractVersion,
        stage: request.stage,
        hardSafetyGatesRemainAuthoritative: true,
        facts: sanitizedFacts,
        context: contextData
      },
      context: contextData,
      questions: {
        [request.questionName]: {
          type: 'choice',
          instructions: request.instructions,
          criteria: request.criteria,
          choices: [...request.allowed]
        },
        ...(request.questionName === 'action'
          ? {
              score: {
                type: 'score',
                instructions: 'Pontuação de qualidade e segurança do token de 0 a 100',
                criteria: [
                  '0 - Risco extremo de rug pull ou contrato malicioso',
                  '25 - Alto risco, métricas frágeis ou desbalanceamento tóxico',
                  '50 - Neutro, contexto insuficiente para alocação',
                  '75 - Aprovado, fundamentos e métricas on-chain seguros',
                  '100 - Alta convicção, liquidez robusta e forte momentum'
                ],
                range: [0, 100]
              }
            }
          : {})
      },
      lang: 'pt',
      min_confidence: request.minConfidence
    };

    const maxAttempts = 2;
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const started = Date.now();
      try {
        const response = await this.httpClient.post(
          `${this.baseUrl.replace(/\/$/, '')}/v1/systemone`,
          payload,
          {
            timeout: this.timeoutMs,
            headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined
          }
        );

        const data = response.data || {};
        const answer = data.answers?.[request.questionName];
        const rawAction = String(answer?.choice || '').trim().toUpperCase() as TAction;

        if (!request.allowed.includes(rawAction)) {
          throw new Error(`Laya nativa retornou ação inválida em ${request.stage}: ${rawAction || 'ausente'}`);
        }

        const confidence = Number(answer?.answer_confidence);
        if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
          throw new Error('Laya nativa retornou answer_confidence inválida');
        }

        const rawScore =
          answer?.score ??
          answer?.risk_score ??
          (data.answers?.score?.value ?? data.answers?.score?.score ?? data.answers?.score);
        const score = Number.isFinite(Number(rawScore)) ? Number(rawScore) : Math.round(confidence * 100);

        const abstention = typeof answer?.abstention === 'string' ? answer.abstention : undefined;
        const lowConfidence = answer?.low_confidence === true || abstention === 'abstained';
        const effectiveAction =
          lowConfidence && request.allowed.includes('ABSTAIN' as TAction)
            ? ('ABSTAIN' as TAction)
            : rawAction;

        return {
          action: effectiveAction,
          confidence,
          score,
          abstention,
          lowConfidence,
          routingModel: typeof data.routing?.model === 'string' ? data.routing.model : undefined,
          latencyMs: Date.now() - started,
          raw: data
        };
      } catch (err: any) {
        lastError = err;
        const errorDetail = extractLayaErrorMessage(err);
        const statusCode = err?.response?.status ? `HTTP ${err.response.status}` : 'NETWORK_ERROR';
        console.warn(
          `[LayaClient] Tentativa ${attempt}/${maxAttempts} falhou para ${request.stage} (${statusCode}): ${errorDetail}`
        );

        // Se for erro de validação (422) ou erro de autenticação (401/403), não repete
        if (err?.response?.status && err.response.status >= 400 && err.response.status < 500) {
          break;
        }

        // Se for timeout ou erro transitório de rede, aguarda 150ms e retenta uma vez
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
      }
    }

    const finalDetail = extractLayaErrorMessage(lastError);
    const finalStatus = lastError?.response?.status ? `HTTP ${lastError.response.status}` : 'NETWORK_ERROR';
    const enrichedError = new Error(`Laya API Error (${finalStatus}): ${finalDetail}`);
    (enrichedError as any).response = lastError?.response;
    (enrichedError as any).status = lastError?.response?.status;
    (enrichedError as any).detail = finalDetail;
    throw enrichedError;
  }

  /** Probe operacional sem efeito financeiro. Valida conectividade e checkpoint carregado. */
  public async checkHealth(): Promise<{ ok: boolean; loaded: string[]; latencyMs: number }> {
    this.assertConfigured();
    const started = Date.now();
    const response = await this.httpClient.get(
      `${this.baseUrl.replace(/\/$/, '')}/health`,
      {
        timeout: this.timeoutMs,
        headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : undefined
      }
    );
    const data = response.data || {};
    return {
      ok: response.status >= 200 && response.status < 300,
      loaded: Array.isArray(data.loaded) ? data.loaded.map((x: unknown) => String(x)) : [],
      latencyMs: Date.now() - started
    };
  }

  /**
   * Contrato legado de triagem/roteamento.
   * Mantido para observabilidade e compatibilidade do gatekeeper.
   */
  public async evaluate(facts: SolanaLayaFacts): Promise<SolanaLayaDecision> {
    const body = [
      'Pré-entrada de memecoin Solana após todos os filtros determinísticos obrigatórios terem sido aprovados.',
      `Liquidez USD: ${facts.liquidityUsd}. Holders: ${facts.holdersCount}.`,
      `Mint authority revogada: ${facts.mintAuthorityRevoked ? 'sim' : 'não'}. Freeze authority revogada: ${facts.freezeAuthorityRevoked ? 'sim' : 'não'}.`,
      `RugCheck score: ${facts.rugCheckScore}/100. LP trancada/queimada: ${facts.lpLockedPct ?? 'desconhecida'}%. Top holders: ${facts.topHoldersPct ?? 'desconhecido'}%.`,
      `Momentum 5m: ${facts.priceChangeM5 ?? 'desconhecido'}%. Compras/Vendas 5m: ${facts.buysM5 ?? 'desconhecido'}/${facts.sellsM5 ?? 'desconhecido'}.`,
      `Volume comprador/vendedor 5m: ${facts.volumeBuysM5 ?? 'desconhecido'}/${facts.volumeSellsM5 ?? 'desconhecido'}.`,
      'A Laya atua aqui como Sistema 1 de triagem. Regras de segurança e execução continuam fora da Laya.',
      'Roteie para MECHANICAL_PIPELINE quando o contexto estiver claro; DEEP_REVIEW quando houver ambiguidade relevante; ABSTAIN quando o contexto for insuficiente.'
    ].join(' ');

    const result = await this.askChoice<SolanaLayaRoute>({
      facts,
      contractVersion: 'solana-laya/v1',
      stage: 'PRE_ENTRY_TRIAGE',
      body,
      questionName: 'route',
      instructions: 'Para qual caminho de processamento este contexto deve ser encaminhado?',
      criteria: {
        MECHANICAL_PIPELINE: 'Contexto suficientemente claro para continuar pelas regras determinísticas do projeto Solana.',
        DEEP_REVIEW: 'Contexto ambíguo ou conflitante; exige análise deliberada adicional antes de prosseguir.',
        ABSTAIN: 'Informação insuficiente para uma triagem confiável.'
      },
      allowed: ['MECHANICAL_PIPELINE', 'DEEP_REVIEW', 'ABSTAIN'] as const,
      minConfidence: Number(process.env.SOLANA_LAYA_MIN_CONFIDENCE || 0.85)
    });

    return {
      route: result.action,
      routeConfidence: result.confidence,
      abstention: result.abstention,
      lowConfidence: result.lowConfidence,
      routingModel: result.routingModel,
      latencyMs: result.latencyMs,
      raw: result.raw
    };
  }

  /**
   * Decisão tática de entrada.
   * É chamada somente depois dos hard gates determinísticos e do momentum gate.
   * BUY permite avançar para sizing/Jupiter; WAIT/ABSTAIN não abrem posição.
   */
  public async evaluateEntry(
    facts: SolanaLayaFacts
  ): Promise<SolanaLayaTacticalDecision<SolanaLayaEntryAction>> {
    const body = [
      'Decisão tática de entrada em memecoin Solana.',
      'Todos os hard gates determinísticos de segurança, contrato, macro e momentum já foram aprovados.',
      `Liquidez USD: ${facts.liquidityUsd}. Holders: ${facts.holdersCount}. RugCheck score: ${facts.rugCheckScore}/100.`,
      `Momentum 5m: ${facts.priceChangeM5 ?? 'desconhecido'}%. Compras/Vendas: ${facts.buysM5 ?? 'desconhecido'}/${facts.sellsM5 ?? 'desconhecido'}.`,
      `Volume comprador/vendedor: ${facts.volumeBuysM5 ?? 'desconhecido'}/${facts.volumeSellsM5 ?? 'desconhecido'}.`,
      'A Laya escolhe apenas a ação tática entre opções já permitidas pelo projeto.',
      'BUY significa prosseguir para sizing, simulação e possível execução; WAIT significa não entrar neste ciclo; ABSTAIN significa não decidir por confiança insuficiente.'
    ].join(' ');

    return this.askChoice<SolanaLayaEntryAction>({
      facts,
      contractVersion: 'solana-laya-entry/v1',
      stage: 'ENTRY_DECISION',
      body,
      questionName: 'action',
      instructions: 'Qual ação tática de Sistema 1 é adequada agora?',
      criteria: {
        BUY: 'Contexto favorável e seguro (score >= 75) para prosseguir para sizing e simulação de compra.',
        WAIT: 'Ativo potencialmente válido, mas o contexto imediato ainda não justifica abrir posição neste ciclo.',
        ABSTAIN: 'Contexto insuficiente, conflitante ou confiança baixa para aprovar.',
        REJECT: 'Risco detectado pela IA Laya, vetar imediatamente.',
        VETO: 'Risco crítico on-chain ou anomalia detectada pela IA Laya, vetar imediatamente.'
      },
      allowed: ['BUY', 'WAIT', 'ABSTAIN', 'REJECT', 'VETO'] as const,
      minConfidence: Number(process.env.SOLANA_LAYA_MIN_CONFIDENCE || 0.85)
    });
  }

  /**
   * Decisão tática para posição aberta.
   * Hard exits (stop, trailing, watchdog, emergência) são tratados antes e sempre prevalecem.
   * A Laya pode manter a posição ou antecipar uma saída quando nenhum hard exit foi disparado.
   */
  public async evaluatePosition(
    facts: SolanaLayaPositionFacts
  ): Promise<SolanaLayaTacticalDecision<SolanaLayaPositionAction>> {
    const body = [
      'Gestão tática de posição já aberta em memecoin Solana.',
      'Nenhum hard exit determinístico foi disparado neste instante; stop-loss, trailing, watchdog e emergências continuam soberanos fora da Laya.',
      `PnL atual: ${(facts.pnlPct * 100).toFixed(2)}%. Pico de PnL: ${(facts.peakPnlPct * 100).toFixed(2)}%.`,
      `Tempo em posição: ${facts.holdingSeconds}s. Parcial já realizada: ${facts.partialTaken ? 'sim' : 'não'}.`,
      `Preço atual/entrada: ${facts.currentPriceUsd ?? 'desconhecido'}/${facts.entryPriceUsd}.`,
      `Última liquidez conhecida: ${facts.lastKnownLiquidityUsd ?? 'desconhecida'}. Último volume 5m conhecido: ${facts.lastKnownVolume5mUsd ?? 'desconhecido'}.`,
      'HOLD mantém a posição sob as proteções determinísticas existentes; EXIT antecipa a liquidação total; ABSTAIN não cria ação financeira.'
    ].join(' ');

    return this.askChoice<SolanaLayaPositionAction>({
      facts,
      contractVersion: 'solana-laya-position/v1',
      stage: 'POSITION_MANAGEMENT',
      body,
      questionName: 'action',
      instructions: 'Qual ação tática é mais adequada para esta posição agora?',
      criteria: {
        HOLD: 'A posição ainda merece permanecer aberta sob os stops e proteções determinísticas do projeto.',
        EXIT: 'O contexto deteriorou o suficiente para antecipar a saída total, mesmo sem hard exit já disparado.',
        ABSTAIN: 'Não há confiança suficiente para alterar a manutenção normal da posição.'
      },
      allowed: ['HOLD', 'EXIT', 'ABSTAIN'] as const,
      minConfidence: Number(process.env.SOLANA_LAYA_MIN_CONFIDENCE || 0.85)
    });
  }
}
