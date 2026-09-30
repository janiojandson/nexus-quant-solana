import axios from 'axios';
import {
  computeCollisionUsd,
  describeSlippageParams,
  HARD_CAP_SLIPPAGE_BPS
} from './slippageCalibration.js';

export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps?: number;
  autoSlippage?: boolean;
  autoSlippageCollisionUsdValue?: number;
  maxAutoSlippageBps?: number;
  /** Liquidez real da pool em USD. Baseia a calibracao dinamica da colisao. */
  poolLiquidityUsd?: number | null;
}

export interface SwapQuoteResult {
  inputMint: string;
  outputMint: string;
  inAmount: number;
  outAmount: number;
  priceImpactPct: number;
  slippageBps: number;
  routePlanSummary: string;
  rawQuote?: any;
}

/**
 * Erro explícito de falha na camada de cotação (política Fail-Closed).
 *
 * Existe para impedir que qualquer falha de rede, rate-limit (429) ou resposta
 * malformada da Jupiter seja silenciosamente convertida em cotação. Sem esta
 * excecao, o motor executaria ordens com `outAmount` inventado.
 */
export class JupiterQuoteException extends Error {
  public readonly status?: number;
  public readonly cause?: unknown;

  constructor(message: string, status?: number, cause?: unknown) {
    super(message);
    this.name = 'JupiterQuoteException';
    this.status = status;
    this.cause = cause;
  }
}

export class DexAggregatorService {
  private jupiterApiBaseUrl: string;
  public static readonly MAX_ALLOWED_SLIPPAGE_BPS = HARD_CAP_SLIPPAGE_BPS; // 750 bps (7.5%)
  public static readonly MIN_SLIPPAGE_FLOOR_BPS = 250; // 250 bps (2.5%) - Piso para memecoins de alta velocidade

  constructor(jupiterApiBaseUrl = process.env.JUPITER_API_URL || 'https://public.jupiterapi.com') {
    this.jupiterApiBaseUrl = jupiterApiBaseUrl;
  }

  public async getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    const slippageBps = params.slippageBps ?? 50; // Padrão 0.5%
    const maxAutoSlippageBps = params.maxAutoSlippageBps ?? DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS;

    // CORREÇÃO ERRO 6014: Piso de slippage para proteger contra oscilações de bloco
    // Em memecoins com alta velocidade (ex: 571 buys em 5min), o preço oscila 0,5-1,5%
    // por bloco. Slippage < 250 bps causa rejeição espúria (Custom: 6014).
    const slippageFloor = DexAggregatorService.MIN_SLIPPAGE_FLOOR_BPS;
    
    // Teto anti-MEV aplicado em AMBOS os modos. A validacao anterior apenas
    // cobria o caminho com slippage explícito, deixando as compras
    // (autoSlippage=true) sem nenhuma protecao.
    let effectiveSlippageBps = params.autoSlippage ? maxAutoSlippageBps : slippageBps;
    
    // Aplica o piso: nunca permite slippage abaixo de 250 bps
    if (effectiveSlippageBps < slippageFloor) {
      console.log(`⚠️ [Slippage Floor] Ajustando slippage de ${effectiveSlippageBps} bps para piso mínimo de ${slippageFloor} bps (proteção contra erro 6014)`);
      effectiveSlippageBps = slippageFloor;
    }
    
    if (effectiveSlippageBps > DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS) {
      throw new JupiterQuoteException(
        `Slippage maximo excedido (${effectiveSlippageBps} bps). Teto seguro contra sandwich MEV e ${DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS} bps.`
      );
    }

    const queryParams: Record<string, any> = {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amountLamports
    };

    if (params.autoSlippage) {
      // Colisao dinamica. O valor fixo de 1000 USD dimensionava o slippage
      // como se fosse um negocio grande, o que em pool rasa (15k-100k) gerava
      // erro 6014 (SlippageExceeded) falso positivo em quase toda entrada.
      const collisionUsd =
        params.autoSlippageCollisionUsdValue ?? computeCollisionUsd(params.poolLiquidityUsd);
      queryParams.autoSlippage = true;
      queryParams.autoSlippageCollisionUsdValue = collisionUsd;
      queryParams.maxAutoSlippageBps = effectiveSlippageBps; // Usa o valor após aplicar piso
      console.log(
        describeSlippageParams({
          sizeSol: params.amountLamports / 1e9,
          collisionUsd,
          poolLiquidityUsd: params.poolLiquidityUsd,
          maxAutoSlippageBps: effectiveSlippageBps
        })
      );
    } else {
      queryParams.slippageBps = effectiveSlippageBps; // Usa o valor após aplicar piso
    }

    let response;
    try {
      response = await axios.get(`${this.jupiterApiBaseUrl}/quote`, {
        params: queryParams,
        timeout: 5000
      });
    } catch (err: any) {
      // Fail-Closed: NAO existe mais caminho de fallback. Uma falha de cotação
      // aborta o trade; jamais e convertida em preco ficticio.
      const status = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message || String(err);
      console.error(
        `[JupiterQuoteException] Falha ao cotar ${params.inputMint} -> ${params.outputMint} (${params.amountLamports} lamports): ${detail}`
      );
      throw new JupiterQuoteException(
        `Falha na cotação Jupiter (${status ?? 'sem status'}): ${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`,
        status,
        err
      );
    }

    const data = response?.data;

    // Validacao de integridade: resposta sem par in/out e cotação inutilizavel.
    if (!data || data.inAmount === undefined || data.outAmount === undefined) {
      console.error('[JupiterQuoteException] Resposta da Jupiter sem inAmount/outAmount:', JSON.stringify(data));
      throw new JupiterQuoteException('Resposta inválida da Jupiter: inAmount/outAmount ausentes.');
    }

    const result = {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: Number(data.inAmount),
      outAmount: Number(data.outAmount),
      priceImpactPct: Number(data.priceImpactPct || 0),
      slippageBps: params.autoSlippage ? effectiveSlippageBps : effectiveSlippageBps,
      routePlanSummary:
        data.routePlan?.map((r: { swapInfo: { label: string } }) => r.swapInfo?.label).join(' -> ') || 'Direct',
      rawQuote: data
    };

    // Log do slippage efetivo usado (diagnóstico de erro 6014)
    console.log(
      `📊 [JupiterQuote] Slippage configurado: ${result.slippageBps} bps | Price Impact: ${result.priceImpactPct.toFixed(3)}% | Rota: ${result.routePlanSummary}`
    );

    return result;
  }
}
