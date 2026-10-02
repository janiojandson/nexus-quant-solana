import axios from 'axios';

export type SolanaLayaAction = 'PROCEED' | 'WATCH' | 'VETO';

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

export interface SolanaLayaDecision {
  action: SolanaLayaAction;
  actionConfidence: number;
  residualRiskScore?: number;
  residualRiskConfidence?: number;
  needsDeeperReview?: number;
  needsDeeperReviewConfidence?: number;
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

export class SolanaLayaAdapter {
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly httpClient: typeof axios;

  constructor(options: SolanaLayaAdapterOptions = {}) {
    this.baseUrl = options.baseUrl
      || process.env.SOLANA_LAYA_NATIVE_URL
      || 'http://nexus-decisor-laya-next.railway.internal:8080';
    this.apiKey = options.apiKey || process.env.LAYA_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.SOLANA_LAYA_TIMEOUT_MS || 4000);
    this.httpClient = options.httpClient || axios;
  }

  public async evaluate(facts: SolanaLayaFacts): Promise<SolanaLayaDecision> {
    if (!this.apiKey) throw new Error('LAYA_API_KEY ausente para contrato nativo');

    const payload = {
      state: {
        domain: 'solana_memecoin',
        contractVersion: 'solana-laya/v1',
        stage: 'PRE_ENTRY_RESIDUAL_RISK',
        deterministicGatesPassed: true,
        facts
      },
      questions: {
        action: {
          type: 'choice',
          instructions: 'Qual é a decisão residual de Sistema 1 para esta oportunidade?',
          criteria: {
            PROCEED: 'Fatos objetivos passaram; fluxo e momentum são coerentes. Prosseguir somente para sizing e simulação.',
            WATCH: 'Há incerteza ou sinais mistos. Aguardar nova observação sem abrir posição.',
            VETO: 'Há risco residual ou deterioração suficiente para bloquear a oportunidade.'
          }
        },
        residual_risk: {
          type: 'score',
          instructions: 'Qual o risco residual após os filtros determinísticos?',
          criteria: ['baixo', 'moderado', 'alto', 'crítico']
        },
        needs_deeper_review: {
          type: 'noul',
          instructions: 'Os fatos apresentam ambiguidade que exige revisão adicional antes de qualquer entrada?'
        }
      },
      lang: 'pt'
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
    const actionAnswer = data.answers?.action;
    const rawAction = String(actionAnswer?.choice || '').trim().toUpperCase();
    if (!['PROCEED', 'WATCH', 'VETO'].includes(rawAction)) {
      throw new Error(`Laya nativa retornou action inválida: ${rawAction || 'ausente'}`);
    }

    const actionConfidence = Number(actionAnswer?.answer_confidence);
    if (!Number.isFinite(actionConfidence) || actionConfidence < 0 || actionConfidence > 1) {
      throw new Error('Laya nativa retornou answer_confidence inválida');
    }

    const riskAnswer = data.answers?.residual_risk;
    const reviewAnswer = data.answers?.needs_deeper_review;

    return {
      action: rawAction as SolanaLayaAction,
      actionConfidence,
      residualRiskScore: Number.isFinite(Number(riskAnswer?.score)) ? Number(riskAnswer.score) : undefined,
      residualRiskConfidence: Number.isFinite(Number(riskAnswer?.answer_confidence))
        ? Number(riskAnswer.answer_confidence) : undefined,
      needsDeeperReview: Number.isFinite(Number(reviewAnswer?.noul)) ? Number(reviewAnswer.noul) : undefined,
      needsDeeperReviewConfidence: Number.isFinite(Number(reviewAnswer?.answer_confidence))
        ? Number(reviewAnswer.answer_confidence) : undefined,
      routingModel: typeof data.routing?.model === 'string' ? data.routing.model : undefined,
      latencyMs: Date.now() - started,
      raw: data
    };
  }
}
