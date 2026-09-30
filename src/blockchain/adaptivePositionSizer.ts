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

export type SizingAbortReason = 'INSUFFICIENT_POOL_DEPTH' | 'QUOTE_UNAVAILABLE';

export interface AdaptiveSizingResult {
  success: boolean;
  sizeSol: number;
  quote: SwapQuoteResult | null;
  attempts: Array<{ sizeSol: number; priceImpactPct: number; accepted: boolean }>;
  abortReason?: SizingAbortReason;
  error?: string;
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
   * `predicate` permite validar o lote final contra a simulação real: se a
   * simulação pré-voo rejeitar (ex. 6014), o lote é tratado como insuficiente.
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
    const attempts: AdaptiveSizingResult['attempts'] = [];

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
      attempts.push({ sizeSol, priceImpactPct, accepted: impactOk });

      if (!impactOk) {
        console.warn(`[AdaptiveSizing] Lote ${sizeSol} SOL rejeitado: Price Impact ${priceImpactPct.toFixed(3)}% > tolerância ${targetImpact}%`);
        continue;
      }

      // Impacte aceitável: confirma com a validação real (simulação pré-voo), se houver.
      if (options?.validate) {
        const validationError = await options.validate(quote, sizeSol);
        if (validationError) {
          attempts[attempts.length - 1].accepted = false;
          console.warn(`[AdaptiveSizing] Lote ${sizeSol} SOL passou no impacto mas falhou na validação: ${validationError}`);
          continue;
        }
      }

      console.log(`[AdaptiveSizing] Lote aprovado: ${sizeSol} SOL | Price Impact ${priceImpactPct.toFixed(3)}%`);
      return { success: true, sizeSol, quote, attempts };
    }

    const worstImpact = attempts.length ? Math.max(...attempts.map((a) => a.priceImpactPct)) : 0;
    const error = `INSUFFICIENT_POOL_DEPTH: nenhum lote entre ${this.ladderSol[this.ladderSol.length - 1]} e ${this.ladderSol[0]} SOL atingiu Price Impact <= ${targetImpact}% (pior: ${worstImpact.toFixed(3)}%, teto: ${maxImpact}%)`;
    console.warn(`[AdaptiveSizing] ${error}`);
    return {
      success: false,
      sizeSol: 0,
      quote: null,
      attempts,
      abortReason: 'INSUFFICIENT_POOL_DEPTH',
      error
    };
  }
}