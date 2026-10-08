const MAX_U64 = 18446744073709551615n;

/** Convert an explicitly UI-denominated amount, never an on-chain atomic u64/BN. */
export function uiToAtomic(value: unknown, decimals: 6 | 9): string {
  if (decimals !== 6 && decimals !== 9) {
    throw new RangeError('Unsupported decimal scale');
  }
  const scale = 10n ** BigInt(decimals);
  let atomic: bigint;

  if (typeof value === 'string') {
    const decimal = value.trim();
    if (!/^\d+(?:\.\d+)?$/.test(decimal)) {
      throw new TypeError('Invalid UI decimal amount');
    }
    const [whole, fraction = ''] = decimal.split('.');
    const paddedFraction = fraction.slice(0, decimals).padEnd(decimals, '0');
    atomic = BigInt(whole) * scale + BigInt(paddedFraction);
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0 || Object.is(value, -0)) {
      throw new TypeError('Invalid numeric UI amount');
    }
    const scaled = value * Number(scale);
    const rounded = Math.round(scaled);
    const tolerance = Math.min(0.125, Math.max(1e-6, Number.EPSILON * Math.abs(scaled) * 4));
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > tolerance) {
      throw new RangeError('Numeric UI amount has unsafe precision');
    }
    atomic = BigInt(rounded);
  } else {
    throw new TypeError('UI amount must be a decimal string or number');
  }

  if (atomic > MAX_U64) {
    throw new RangeError('UI amount exceeds u64');
  }
  return atomic.toString();
}

/** Normalize PumpPortal UI decimals; decoded on-chain atomic reserves must not enter here. */
export function normalizePumpReserves(reserves: {
  vTokensInBondingCurve: unknown;
  vSolInBondingCurve: unknown;
}): { virtualTokenReservesAtomic: string; virtualSolReservesAtomic: string } {
  const virtualTokenReservesAtomic = uiToAtomic(reserves.vTokensInBondingCurve, 6);
  const virtualSolReservesAtomic = uiToAtomic(reserves.vSolInBondingCurve, 9);
  if (virtualTokenReservesAtomic === '0' || virtualSolReservesAtomic === '0') {
    throw new RangeError('Pump reserves must be positive');
  }
  return { virtualTokenReservesAtomic, virtualSolReservesAtomic };
}

export function safeAsyncListener<T>(
  handler: (event: T) => void | Promise<void>,
  warn: (message: string) => void,
): (event: T) => void {
  const reportFailure = (): void => {
    try {
      warn('Pump trade listener failed');
    } catch {
      // Warning sinks cannot make an event listener throw or reject.
    }
  };
  return (event: T): void => {
    try {
      void Promise.resolve(handler(event)).catch(reportFailure);
    } catch {
      reportFailure();
    }
  };
}
