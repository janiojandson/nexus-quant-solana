import { DexAggregatorService, JupiterQuoteException, SwapQuoteParams, SwapQuoteResult } from './dexAggregator.js';

/**
 * Dimensionamento adaptativo de lote por profundidade de pool.
 *
 * Contexto: com lote fixo de 0.05 SOL, todos os tokens aprovados pelo pipeline
 * morriam com erro 6014 (SlippageExceeded) na simulação pré-voo. A causa não era
 * a estratégia, era o tamanho da ordem versus a profundidade real da pool.
 *
 * Estratégia: escalonar o lote do teto para o piso, aceitando apenas lotes cujo
 * Price Impact fique dentro da tolerância. Se o piso não for suficiente, aborta
 * com INSUFFICIENT_POOL_DEPTH em vez de insistir num lote que será rejeitado.
 */

export const MAX_TRADE_AMOUNT_SOL = 0.05;
export const MIN_TRADE_AMOUNT_SOL = 0.015;
export const LADDER_SOL = [0.05, 0.035, 0.02, 0.015];

/** Aborta acima deste impacto na primeira tentativa — indica pool rasa. */
export const MAX_PRICE_IMPACT_PCT = 3.0;
/** Tolerância do lote final aceito. */
export const TARGET_PRICE_IMPACT_PCT = 2.5;

export type SizingAbortReason = 'INSUFFICIENT_POOL_DEPTH' | 'QUOTE_UNAVAILABLE' | 'SIMULATION_REJECTED';

export type AttemptRejection = 'PRICE_IMPACT' | 'SIMULATION';

export interface SizingAttempt {
  sizeSol: number;
  priceImpactPct: number;
  accepted: boolean;
  /** Motivo da rejeição, quando houver. Ausente = degrau aprovado. */
  rejectedBy?: AttemptRejection;
  /** Detalhe do erro (mensagem da simulação, por ex.). */
  detail?: string;
}

export interface AdaptiveSizingResult {
  success: boolean;
  sizeSol: number;
  quote: SwapQuoteResult | null;
  attempts: SizingAttempt[];
  abortReason?: SizingAbortReason;
  error?: string;
}

/** Extrai o código de erro on-chain (ex.: 6014) de um JSON de InstructionError. */
function extractCustomError(detail: string): string {
  const m = detail.match(/"Custom":\s*(\d+)/);
  return m ? m[1] : detail;
}

export class AdaptivePositionSizer {
  private readonly aggregator: DexAggregatorService;
  private readonly ladderSol: number[];

  constructor(aggregator?: DexAggregatorService, ladderSol: number[] = LADDER_SOL) {
    this.aggregator = aggregator ?? new DexAggregatorService();
    this.ladderSol = [...ladderSol].sort((a, b) => b - a);
  }

  /**
   * Sobe (ou desce) a escada de lotes até encontrar um tamanho aceitável.
   * `validate` permite validar o lote final contra a simulação real: se a
   * simulação pré-voo rejeitar (ex. 6014), o lote é tratado como insuficiente.
   *
   * O hook DEVE retornar `null` (ou `undefined`) em caso de sucesso e uma
   * string descritiva em caso de falha — é esse contrato que decide se o degrau
   * é aceito.
   */
  public async findExecutableSize(
    quoteParams: Omit<SwapQuoteParams, 'amountLamports'>,
    options?: {
      maxPriceImpactPct?: number;
      targetPriceImpactPct?: number;
      /** Simulação adicional (pré-voo). Retorne string de erro para rejeitar o lote. */
      validate?: (quote: SwapQuoteResult, sizeSol: number) => Promise<string | null>;
    }
  ): Promise<AdaptiveSizingResult> {
    const maxImpact = options?.maxPriceImpactPct ?? MAX_PRICE_IMPACT_PCT;
    const targetImpact = options?.targetPriceImpactPct ?? TARGET_PRICE_IMPACT_PCT;
    const attempts: SizingAttempt[] = [];
    const rejectionsBySimulation: string[] = [];

    for (const sizeSol of this.ladderSol) {
      const amountLamports = Math.floor(sizeSol * 1e9);

      let quote: SwapQuoteResult;
      try {
        quote = await this.aggregator.getQuote({ ...quoteParams, amountLamports });
      } catch (err: any) {
        const detail = err instanceof JupiterQuoteException ? err.message : (err?.message || String(err));
        console.warn(`[AdaptiveSizing] Lote ${sizeSol} SOL descartado: cotação indisponível (${detail})`);
        // Falha de cotação é fail-closed: não há como dimensionar sem preço.
        return {
          success: false,
          sizeSol: 0,
          quote: null,
          attempts,
          abortReason: 'QUOTE_UNAVAILABLE',
          error: detail
        };
      }

      const priceImpactPct = Math.abs(Number(quote.priceImpactPct || 0));
      const impactOk = priceImpactPct <= targetImpact;

      if (!impactOk) {
        const detail = `Price Impact ${priceImpactPct.toFixed(3)}% > tolerância ${targetImpact}%`;
        attempts.push({ sizeSol, priceImpactPct, accepted: false, rejectedBy: 'PRICE_IMPACT', detail });
        console.warn(`[AdaptiveSizing] Degrau ${sizeSol} SOL: REJEITADO (${detail})`);
        continue;
      }

      // Impacte aceitável: confirma com a validação real (simulação pré-voo), se houver.
      if (options?.validate) {
        const validationError = await options.validate(quote, sizeSol);
        if (validationError) {
          attempts.push({
            sizeSol,
            priceImpactPct,
            accepted: false,
            rejectedBy: 'SIMULATION',
            detail: validationError
          });
          rejectionsBySimulation.push(`${sizeSol}SOL: ${extractCustomError(validationError)}`);
          console.warn(
            `[AdaptiveSizing] Degrau ${sizeSol} SOL: SIMULAÇÃO REPROVADA — Price Impact ${priceImpactPct.toFixed(3)}% estava OK, ` +
            `mas o pré-voo rejeitou: ${extractCustomError(validationError)}`
          );
          continue;
        }
      }

      attempts.push({ sizeSol, priceImpactPct, accepted: true });
      console.log(`[AdaptiveSizing] Degrau ${sizeSol} SOL: APROVADO | Price Impact ${priceImpactPct.toFixed(3)}%`);
      return { success: true, sizeSol, quote, attempts };
    }

    // Todas as tentativas falharam. A mensagem precisa refletir a causa REAL:
    // blaming no Price Impact quando a simulação reprovou mandava o operador
    // procurar no lugar errado.
    const error = this.buildAbortMessage(targetImpact, maxImpact, attempts, rejectionsBySimulation);
    console.warn(`[AdaptiveSizing] ${error}`);

    return {
      success: false,
      sizeSol: 0,
      quote: null,
      attempts,
      abortReason: rejectionsBySimulation.length > 0 ? 'SIMULATION_REJECTED' : 'INSUFFICIENT_POOL_DEPTH',
      error
    };
  }

  private buildAbortMessage(
    targetImpact: number,
    maxImpact: number,
    attempts: SizingAttempt[],
    simulationRejections: string[]
  ): string {
    const ladder = `${this.ladderSol[this.ladderSol.length - 1]} a ${this.ladderSol[0]} SOL`;
    const trace = attempts
      .map((a) => `${a.sizeSol}SOL[pi=${a.priceImpactPct.toFixed(3)}%${a.accepted ? ',aprovado' : `,${a.rejectedBy}`}]`)
      .join(' -> ');

    if (simulationRejections.length > 0) {
      const impacts = attempts.map((a) => a.priceImpactPct);
      const best = impacts.length ? Math.min(...impacts) : 0;
      const worst = impacts.length ? Math.max(...impacts) : 0;
      return (
        `SIMULATION_REJECTED: a cotação passou em todos os degraus (Price Impact ${best.toFixed(3)}%–${worst.toFixed(3)}%, ` +
        `muito abaixo da tolerância de ${targetImpact}%), mas a simulação pré-voo on-chain reprovou cada lote. ` +
        `Causa: profundidade insuficiente para o tamanho pedido (erro 6014 = SlippageExceeded), não filtro de impacto. ` +
        `Escada percorrida: ${trace}. Detalhe: ${simulationRejections[0]}`
      );
    }

    const worstImpact = impacts_of(attempts);
    return (
      `INSUFFICIENT_POOL_DEPTH: nenhum lote entre ${ladder} atingiu Price Impact <= ${targetImpact}% ` +
      `(pior: ${worstImpact.toFixed(3)}%, teto de hard-cap: ${maxImpact}%). Escada: ${trace}`
    );
  }
}

function impacts_of(attempts: SizingAttempt[]): number {
  return attempts.length ? Math.max(...attempts.map((a) => a.priceImpactPct)) : 0;
}
