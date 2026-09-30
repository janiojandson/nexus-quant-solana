/**
 * Blindagem de unidades atômicas (SPL) contra regressão de decimais.
 *
 * Origem do risco: saldos de token existem em duas escalas.
 *   - uiAmount  : 5.389267  (float legível, PERDE precisão)
 *   - amount     : "5389267" (inteiros atômicos, escala real da SPL)
 *
 * Misturar as duas faz `Math.floor(5.389267)` = 5, vendendo 5 lamports em vez
 * de 5,4 milhões — o swap "tem sucesso", a posição fica presa na carteira e o
 * relatório acusa lucro. Estes helpers existem para tornar o erro explícito.
 */

/** Regex de inteiro atômico: apenas dígitos, sem ponto, sem expoente, sem sinal. */
export const ATOMIC_AMOUNT_PATTERN = /^\d+$/;

/** Tolerância máxima de perda em SOL para um round-trip completo (taxas + spread). */
export const MAX_ROUNDTRIP_LOSS_SOL = 0.0015;

export class InvalidAtomicAmountError extends Error {
  constructor(public readonly received: unknown) {
    super(
      `[AtomicAmount] Montante inválido para swap: ${JSON.stringify(received)}. ` +
      `Esperado inteiro atômico em string ou BigInt (ex: "5389267"). ` +
      `Valores em uiAmount/float são proibidos — use tokenAccount.value.amount.`
    );
    this.name = 'InvalidAtomicAmountError';
  }
}

/**
 * Valida que um montante está em unidades atômicas inteiras e é positivo.
 * Rejeita float, notação científica, sinal negativo e valores não numéricos.
 */
export function assertAtomicAmount(amount: unknown): bigint {
  if (typeof amount === 'bigint') {
    if (amount <= 0n) throw new InvalidAtomicAmountError(amount.toString());
    return amount;
  }

  if (typeof amount !== 'string' || !ATOMIC_AMOUNT_PATTERN.test(amount)) {
    throw new InvalidAtomicAmountError(amount);
  }

  const parsed = BigInt(amount);
  if (parsed <= 0n) throw new InvalidAtomicAmountError(amount);
  return parsed;
}

/** Igual a `assertAtomicAmount`, mas devolve o valor como número seguro. */
export function assertAtomicAmountToNumber(amount: unknown): number {
  const big = assertAtomicAmount(amount);
  if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new InvalidAtomicAmountError(`${big} excede Number.MAX_SAFE_INTEGER`);
  }
  return Number(big);
}

/**
 * Converte um saldo uiAmount (legível) para string atômica, usando as
 * decimais do mint. Serve apenas para migração de dados legados — a
 * produção deve sempre ler `value.amount` direto do RPC.
 */
export function uiAmountToAtomic(uiAmount: number | string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 9) {
    throw new Error(`[AtomicAmount] decimals inválido: ${decimals}`);
  }
  const [whole, frac = ''] = String(uiAmount).split('.');
  if (frac.length > decimals) {
    throw new Error(
      `[AtomicAmount] uiAmount ${uiAmount} tem mais que ${decimals} casas decimais; truncamento silencioso corromperia o saldo.`
    );
  }
  return (whole + frac.padEnd(decimals, '0')).replace(/^0+(?=\d)/, '');
}

/** Converte string atômica para uiAmount legível. */
export function atomicToUiAmount(amount: string, decimals: number): number {
  const big = assertAtomicAmount(amount);
  return Number(big) / Math.pow(10, decimals);
}

/**
 * Veredito de retorno financeiro de um round-trip.
 * Usado pelo canário para decidir se o teste passou de verdade.
 */
export interface CapitalReturnVerdict {
  ok: boolean;
  lossSol: number;
  toleranceSol: number;
  reason: string;
}

export function evaluateCapitalReturn(params: {
  initialBalanceSol: number;
  finalBalanceSol: number;
  remainingAtomicAmount: string;
  ataClosed: boolean;
  toleranceSol?: number;
}): CapitalReturnVerdict {
  const toleranceSol = params.toleranceSol ?? MAX_ROUNDTRIP_LOSS_SOL;
  const lossSol = params.initialBalanceSol - params.finalBalanceSol;
  const failures: string[] = [];

  // O saldo remanescente é validado como INTEIRO NÃO-NEGATIVO, não positivo:
  // zero é precisamente o cenário de sucesso (ATA drenada).
  let remaining: bigint;
  if (typeof params.remainingAtomicAmount === 'bigint') {
    remaining = params.remainingAtomicAmount;
  } else if (typeof params.remainingAtomicAmount === 'string' && ATOMIC_AMOUNT_PATTERN.test(params.remainingAtomicAmount)) {
    remaining = BigInt(params.remainingAtomicAmount);
  } else {
    remaining = 0n;
    failures.push(`saldo remanescente ilegível: ${params.remainingAtomicAmount}`);
  }

  if (remaining > 0n) {
    failures.push(`saldo remanescente de ${remaining} unidades atômicas`);
  }
  if (!params.ataClosed) {
    failures.push('ATA nao foi fechada');
  }
  if (lossSol > toleranceSol) {
    failures.push(`perda de ${lossSol.toFixed(6)} SOL excede a tolerancia de ${toleranceSol} SOL`);
  }

  return {
    ok: failures.length === 0,
    lossSol,
    toleranceSol,
    reason: failures.length ? failures.join(' | ') : 'retorno de capital dentro da tolerancia'
  };
}
