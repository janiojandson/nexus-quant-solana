/**
 * Strict boolean environment variable parser.
 * Requirement (Finding Fase 13 & P2-01):
 * Prohibits fuzzy, case-insensitive, or numeric boolean values (e.g. 'TRUE', 'true ', '1', '0').
 * Only exact lowercase 'true' returns true.
 * Exact lowercase 'false', empty string, or undefined returns false.
 * Any other value throws InvalidBooleanEnvError with 'INVALID_BOOLEAN_ENV'.
 */
export class InvalidBooleanEnvError extends Error {
  constructor(public readonly envVar: string, public readonly rawValue: string) {
    super(`INVALID_BOOLEAN_ENV: Environment variable ${envVar} has invalid boolean value '${rawValue}'. Must be exactly 'true', 'false', or unset.`);
    this.name = 'InvalidBooleanEnvError';
  }
}

export function parseStrictBooleanEnv(envVar: string, rawValue?: string): boolean {
  if (rawValue === undefined || rawValue === '') {
    return false;
  }
  if (rawValue === 'true') {
    return true;
  }
  if (rawValue === 'false') {
    return false;
  }
  throw new InvalidBooleanEnvError(envVar, rawValue);
}
