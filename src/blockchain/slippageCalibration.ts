/**
 * Calibração do parâmetro `autoSlippageCollisionUsdValue` da Jupiter v6.
 *
 * A Jupiter dimensiona o slippage automático contra o impacto de uma
 * "colisão" — o tamanho que um participante de mercado aleatórioiro levaria.
 * Fixar esse valor em $1.000 é catastrofico para micro-ordens em pools rasas:
 * numa pool de $15k, um订单 de 0,05 SOL (~US$ 7) representa 0,05% do pool, mas
 * a Jupiter dimensiona o slippage como se fosse robustamente um negócio de
 * $1.000. O resultado é tolerância estreita demais e o erro 6014
 * (SlippageExceeded) em praticamente toda entrada — o sintoma observado.
 *
 * A colisão precisa ser proporcional à profundidade real, com piso que
 * permita micro-ordens e teto que não abra espaço para MEV em pool grande.
 */

/** Divisor da liquidez: colisão = liquidez / 300. */
export const COLLISION_LIQUIDITY_DIVISOR = 1000;
/** Piso em USD — abaixo disso a colisão zera o slippage útil. */
export const MIN_COLLISION_USD = 25;
/** Teto em USD — acima disso a tolerância fica larga demais para MEV. */
export const MAX_COLLISION_USD = 100;
/** Usado quando a liquidez não está disponível no contexto. */
export const FALLBACK_COLLISION_USD = 50;

/** Teto anti-MEV rígido, inegociável. */
export const HARD_CAP_SLIPPAGE_BPS = 750;

/**
 * Calcula a colisão dinâmica a partir da liquidez da pool.
 *
 *   $15.000  -> $25   (piso)
 *   $50.000  -> $50   (interpolado)
 *   $200.000 -> $100  (teto)
 *   $7.500   -> $25   (piso, 0,5% seria $37 mas a ordem é pequena demais)
 *   $1.000   -> $50   (fallback: liquidez irreal, usamos o valor seguro)
 */
export function computeCollisionUsd(poolLiquidityUsd?: number | null): number {
  if (poolLiquidityUsd === undefined || poolLiquidityUsd === null) {
    return FALLBACK_COLLISION_USD;
  }
  if (!Number.isFinite(poolLiquidityUsd) || poolLiquidityUsd <= 0) {
    return FALLBACK_COLLISION_USD;
  }

  const proportional = poolLiquidityUsd / COLLISION_LIQUIDITY_DIVISOR;
  return Math.max(MIN_COLLISION_USD, Math.min(MAX_COLLISION_USD, Math.floor(proportional)));
}

/**
 * Monta a linha de telemetria do quote com os parâmetros de slippage.
 * Usada nos logs para torna auditável por que um lote foi ou não autorizado.
 */
export function describeSlippageParams(params: {
  sizeSol?: number;
  collisionUsd: number;
  poolLiquidityUsd?: number | null;
  maxAutoSlippageBps?: number;
}): string {
  const cap = params.maxAutoSlippageBps ?? HARD_CAP_SLIPPAGE_BPS;
  const size = params.sizeSol !== undefined ? `${params.sizeSol} SOL` : '?';
  const liq = params.poolLiquidityUsd
    ? `$${Math.round(params.poolLiquidityUsd).toLocaleString('en-US')}`
    : 'desconhecida';
  return (
    `[JupiterQuote] ${size} | Colisão estimada: $${params.collisionUsd} ` +
    `| Pool liq: ${liq} | Teto: ${cap} bps`
  );
}
