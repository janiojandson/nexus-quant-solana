import axios from 'axios';

export interface SwapQuoteParams {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps?: number;
  autoSlippage?: boolean;
  autoSlippageCollisionUsdValue?: number;
  maxAutoSlippageBps?: number;
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
 * exceção, o motor executaria ordens com `outAmount` inventado.
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
  public static readonly MAX_ALLOWED_SLIPPAGE_BPS = 750; // 7.5%

  constructor(jupiterApiBaseUrl = process.env.JUPITER_API_URL || 'https://public.jupiterapi.com') {
    this.jupiterApiBaseUrl = jupiterApiBaseUrl;
  }

  public async getQuote(params: SwapQuoteParams): Promise<SwapQuoteResult> {
    const slippageBps = params.slippageBps ?? 50; // Padrão 0.5%
    const maxAutoSlippageBps = params.maxAutoSlippageBps ?? DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS;

    // Teto anti-MEV aplicado em AMBOS os modos. A validação anterior apenas cobria
    // o caminho com slippage explícito, deixando as compras (autoSlippage=true)
    // sem nenhuma proteção.
    const effectiveSlippageBps = params.autoSlippage ? maxAutoSlippageBps : slippageBps;
    if (effectiveSlippageBps > DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS) {
      throw new JupiterQuoteException(
        `Slippage maximo excedido (${effectiveSlippageBps} bps). Teto seguro contra sandwich MEV é ${DexAggregatorService.MAX_ALLOWED_SLIPPAGE_BPS} bps.`
      );
    }

    const queryParams: Record<string, any> = {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      amount: params.amountLamports
    };

    if (params.autoSlippage) {
      queryParams.autoSlippage = true;
      queryParams.autoSlippageCollisionUsdValue = params.autoSlippageCollisionUsdValue ?? 1000;
      queryParams.maxAutoSlippageBps = maxAutoSlippageBps;
    } else {
      queryParams.slippageBps = slippageBps;
    }

    let response;
    try {
      response = await axios.get(`${this.jupiterApiBaseUrl}/quote`, {
        params: queryParams,
        timeout: 5000
      });
    } catch (err: any) {
      // Fail-Closed: NÃO existe mais caminho de fallback. Uma falha de cotação
      // aborta o trade; jamais é convertida em preço fictício.
      const status = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message || String(err);
      console.error(`[JupiterQuoteException] Falha ao cotar ${params.inputMint} -> ${params.outputMint} (${params.amountLamports} lamports): ${detail}`);
      throw new JupiterQuoteException(
        `Falha na cotação Jupiter (${status ?? 'sem status'}): ${typeof detail === 'object' ? JSON.stringify(detail) : String(detail)}`,
        status,
        err
      );
    }

    const data = response?.data;

    // Validação de integridade: resposta sem par in/out é cotação inutilizável.
    if (!data || data.inAmount === undefined || data.outAmount === undefined) {
      console.error('[JupiterQuoteException] Resposta da Jupiter sem inAmount/outAmount:', JSON.stringify(data));
      throw new JupiterQuoteException('Resposta inválida da Jupiter: inAmount/outAmount ausentes.');
    }

    return {
      inputMint: params.inputMint,
      outputMint: params.outputMint,
      inAmount: Number(data.inAmount),
      outAmount: Number(data.outAmount),
      priceImpactPct: Number(data.priceImpactPct || 0),
      slippageBps: params.autoSlippage ? maxAutoSlippageBps : slippageBps,
      routePlanSummary: data.routePlan?.map((r: { swapInfo: { label: string } }) => r.swapInfo?.label).join(' -> ') || 'Direct',
      rawQuote: data
    };
  }
}
