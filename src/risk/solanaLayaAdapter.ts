import axios from 'axios';

export type SolanaLayaRoute = 'MECHANICAL_PIPELINE' | 'DEEP_REVIEW' | 'ABSTAIN';
export type SolanaLayaEntryAction = 'BUY' | 'WAIT' | 'ABSTAIN';
export type SolanaLayaPositionAction = 'HOLD' | 'EXIT' | 'ABSTAIN';

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
  private readonly httpClient: typeof axios;

  constructor(options: SolanaLayaAdapterOptions = {}) {
    this.baseUrl = options.baseUrl || process.env.SOLANA_LAYA_NATIVE_URL || '';
    this.apiKey = options.apiKey || process.env.SOLANA_LAYA_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.SOLANA_LAYA_TIMEOUT_MS || 4000);
    this.httpClient = options.httpClient || axios;
  }

  private assertConfigured(): void {
    if (!this.baseUrl) throw new Error('SOLANA_LAYA_NATIVE_URL ausente para contrato nativo');
    if (!this.apiKey) throw new Error('SOLANA_LAYA_API_KEY ausente para contrato nativo');
  }

  private async askChoice<TAction extends string>(
    request: ChoiceRequest<TAction>
  ): Promise<SolanaLayaTacticalDecision<TAction>> {
    this.assertConfigured();

    const payload = {
      state: {
        body: request.body,
        domain: 'solana_memecoin',
        contractVersion: request.contractVersion,
        stage: request.stage,
        hardSafetyGatesRemainAuthoritative: true,
        facts: request.facts
      },
      questions: {
        [request.questionName]: {
          type: 'choice',
          instructions: request.instructions,
          criteria: request.criteria
        }
      },
      lang: 'pt',
      min_confidence: request.minConfidence
    };

    const started = Date.now();
    const response = await this.httpClient.post(
      `${this.baseUrl.replace(/\/$/, '')}/v1/systemone`,
      payload,
      {
        timeout: this.timeoutMs,
        headers: { Authorization: `Bearer ${this.apiKey}` }
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

    const abstention = typeof answer?.abstention === 'string' ? answer.abstention : undefined;
    const lowConfidence = answer?.low_confidence === true || abstention === 'abstained';
    const effectiveAction = (
      lowConfidence && request.allowed.includes('ABSTAIN' as TAction)
        ? ('ABSTAIN' as TAction)
        : rawAction
    );

    return {
      action: effectiveAction,
      confidence,
      abstention,
      lowConfidence,
      routingModel: typeof data.routing?.model === 'string' ? data.routing.model : undefined,
      latencyMs: Date.now() - started,
      raw: data
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
        BUY: 'Contexto favorável e coerente para prosseguir para sizing e simulação de compra.',
        WAIT: 'Ativo potencialmente válido, mas o contexto imediato ainda não justifica abrir posição neste ciclo.',
        ABSTAIN: 'Contexto insuficiente, conflitante ou confiança baixa para escolher BUY ou WAIT.'
      },
      allowed: ['BUY', 'WAIT', 'ABSTAIN'] as const,
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
