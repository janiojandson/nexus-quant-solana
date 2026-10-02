import axios from 'axios';

export type SolanaLayaRoute = 'MECHANICAL_PIPELINE' | 'DEEP_REVIEW' | 'ABSTAIN';

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
  route: SolanaLayaRoute;
  routeConfidence: number;
  residualRiskScore?: number;
  residualRiskConfidence?: number;
  needsLlm?: number;
  needsLlmConfidence?: number;
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
    this.apiKey = options.apiKey || process.env.SOLANA_LAYA_API_KEY || process.env.LAYA_API_KEY;
    this.timeoutMs = options.timeoutMs ?? Number(process.env.SOLANA_LAYA_TIMEOUT_MS || 4000);
    this.httpClient = options.httpClient || axios;
  }

  public async evaluate(facts: SolanaLayaFacts): Promise<SolanaLayaDecision> {
    if (!this.apiKey) throw new Error('SOLANA_LAYA_API_KEY/LAYA_API_KEY ausente para contrato nativo');

    const body = [
      'Pré-entrada de memecoin Solana após todos os filtros determinísticos obrigatórios terem sido aprovados.',
      `Liquidez USD: ${facts.liquidityUsd}. Holders: ${facts.holdersCount}.`,
      `Mint authority revogada: ${facts.mintAuthorityRevoked ? 'sim' : 'não'}. Freeze authority revogada: ${facts.freezeAuthorityRevoked ? 'sim' : 'não'}.`,
      `RugCheck score: ${facts.rugCheckScore}/100. LP trancada/queimada: ${facts.lpLockedPct ?? 'desconhecida'}%. Top holders: ${facts.topHoldersPct ?? 'desconhecido'}%.`,
      `Momentum 5m: ${facts.priceChangeM5 ?? 'desconhecido'}%. Compras/Vendas 5m: ${facts.buysM5 ?? 'desconhecido'}/${facts.sellsM5 ?? 'desconhecido'}.`,
      `Volume comprador/vendedor 5m: ${facts.volumeBuysM5 ?? 'desconhecido'}/${facts.volumeSellsM5 ?? 'desconhecido'}.`,
      'A Laya atua apenas como Sistema 1 de triagem. Ela não autoriza compra, venda, sizing ou execução financeira.',
      'Roteie para MECHANICAL_PIPELINE quando o contexto estiver claro e puder seguir somente pelas regras determinísticas do domínio; DEEP_REVIEW quando houver ambiguidade relevante; ABSTAIN quando o contexto for insuficiente.'
    ].join(' ');

    const payload = {
      state: {
        body,
        domain: 'solana_memecoin',
        contractVersion: 'solana-laya/v1',
        stage: 'PRE_ENTRY_TRIAGE',
        deterministicGatesPassed: true,
        facts
      },
      questions: {
        route: {
          type: 'choice',
          instructions: 'Para qual caminho de processamento este contexto deve ser encaminhado?',
          criteria: {
            MECHANICAL_PIPELINE: 'Contexto suficientemente claro para continuar somente pelas regras determinísticas do projeto Solana.',
            DEEP_REVIEW: 'Contexto ambíguo ou conflitante; exige análise deliberada adicional antes de prosseguir.',
            ABSTAIN: 'Informação insuficiente para uma triagem confiável.'
          }
        },
        residual_risk: {
          type: 'score',
          instructions: 'Qual o risco operacional residual deste contexto para fins de triagem?',
          criteria: ['baixo', 'moderado', 'alto', 'crítico']
        },
        needs_llm: {
          type: 'noul',
          instructions: 'Este contexto exige análise deliberada adicional por um LLM antes de continuar?'
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
    const routeAnswer = data.answers?.route;
    const rawRoute = String(routeAnswer?.choice || '').trim().toUpperCase();
    if (!['MECHANICAL_PIPELINE', 'DEEP_REVIEW', 'ABSTAIN'].includes(rawRoute)) {
      throw new Error(`Laya nativa retornou route inválida: ${rawRoute || 'ausente'}`);
    }

    const routeConfidence = Number(routeAnswer?.answer_confidence);
    if (!Number.isFinite(routeConfidence) || routeConfidence < 0 || routeConfidence > 1) {
      throw new Error('Laya nativa retornou answer_confidence inválida');
    }

    const riskAnswer = data.answers?.residual_risk;
    const needsLlmAnswer = data.answers?.needs_llm;

    return {
      route: rawRoute as SolanaLayaRoute,
      routeConfidence,
      residualRiskScore: Number.isFinite(Number(riskAnswer?.score)) ? Number(riskAnswer.score) : undefined,
      residualRiskConfidence: Number.isFinite(Number(riskAnswer?.answer_confidence))
        ? Number(riskAnswer.answer_confidence) : undefined,
      needsLlm: Number.isFinite(Number(needsLlmAnswer?.noul)) ? Number(needsLlmAnswer.noul) : undefined,
      needsLlmConfidence: Number.isFinite(Number(needsLlmAnswer?.answer_confidence))
        ? Number(needsLlmAnswer.answer_confidence) : undefined,
      routingModel: typeof data.routing?.model === 'string' ? data.routing.model : undefined,
      latencyMs: Date.now() - started,
      raw: data
    };
  }
}
