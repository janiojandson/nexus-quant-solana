/** Match explicit addresses only; labels such as Pump AMM are not program IDs. */
export function referencesProgram(value: unknown, programId: string): boolean {
  if (typeof value === 'string') return value === programId;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(child => referencesProgram(child, programId));
}
