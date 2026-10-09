import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import type { ConfirmedPoolEvidence } from '../pump/confirmedPoolReader.js';
import { PUMP_SWAP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from '../pump/confirmedPoolReader.js';

export const JUPITER_SWAP_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SOL_MINT = 'So11111111111111111111111111111111111111112';
const PUMP_BUY_EXACT_QUOTE_IN = Buffer.from([198,46,21,82,180,217,232,112]);
const RAYDIUM_SWAP_BASE_INPUT = Buffer.from([143,190,90,218,196,30,51,222]);
const anchorDisc = (name: string): Buffer => createHash('sha256').update(`global:${name}`).digest().subarray(0,8);
const JUPITER_ROUTE_DISCS = [anchorDisc('route'),anchorDisc('shared_accounts_route')];

/** Match explicit addresses only; labels such as Pump AMM are not program IDs. */
export function referencesProgram(value: unknown, programId: string): boolean {
  if (typeof value === 'string') return value === programId;
  if (!value || typeof value !== 'object') return false;
  return Object.values(value).some(child => referencesProgram(child, programId));
}

/** Solana v0 resolves all table writable keys before any table readonly keys. */
export function assembleV0AccountKeys(staticKeys: readonly string[],
  tables: readonly {writable: readonly string[]; readonly: readonly string[]}[]): string[] {
  return [...staticKeys, ...tables.flatMap(table => table.writable),
    ...tables.flatMap(table => table.readonly)];
}

export function isJupiterRouteInstruction(programId: string, data: Uint8Array,
  accounts: readonly string[], taker: string): boolean {
  const bytes = Buffer.from(data);
  return programId === JUPITER_SWAP_PROGRAM && bytes.length >= 8 &&
    JUPITER_ROUTE_DISCS.some(disc => bytes.subarray(0,8).equals(disc)) && accounts.includes(taker);
}

interface InnerInstruction {programId?: unknown;accounts?: unknown;data?: unknown;stackHeight?: unknown}
interface InnerGroup {index?: unknown;instructions?: unknown}
/** Only the documented, single-leg PumpSwap/CPMM CPI shapes are supported. */
export function hasBoundSwapCpi(groups: unknown, parentIndex: number,
  pool: ConfirmedPoolEvidence, mint: string, stake: bigint, minOut: bigint): boolean {
  if (!Array.isArray(groups)) return false;
  const parent = groups.filter((group: InnerGroup) => group?.index === parentIndex);
  if (parent.length !== 1 || !Array.isArray(parent[0]?.instructions)) return false;
  const dexPrograms = new Set([PUMP_SWAP_PROGRAM.toBase58(), RAYDIUM_CPMM_PROGRAM.toBase58()]);
  const swaps = parent[0].instructions.filter((ix: InnerInstruction) => dexPrograms.has(String(ix?.programId)));
  if (swaps.length !== 1) return false;
  const ix = swaps[0] as InnerInstruction;
  if (ix.programId !== pool.programId || !Array.isArray(ix.accounts) ||
      typeof ix.data !== 'string' || ix.stackHeight !== 2) return false;
  const accounts = ix.accounts as unknown[];
  if (!accounts.every(account => typeof account === 'string')) return false;
  let bytes: Buffer;
  try { bytes = Buffer.from(bs58.decode(ix.data)); } catch { return false; }
  let input: bigint, minimum: bigint;
  if (pool.programId === PUMP_SWAP_PROGRAM.toBase58()) {
    if (pool.baseMint !== mint || pool.quoteMint !== SOL_MINT || accounts.length < 9 ||
        accounts[0] !== pool.poolAddress || accounts[3] !== mint || accounts[4] !== SOL_MINT ||
        accounts[7] !== pool.baseVault || accounts[8] !== pool.quoteVault ||
        bytes.length !== 25 || !bytes.subarray(0,8).equals(PUMP_BUY_EXACT_QUOTE_IN) || bytes[24] > 1) return false;
    input = bytes.readBigUInt64LE(8); minimum = bytes.readBigUInt64LE(16);
  } else if (pool.programId === RAYDIUM_CPMM_PROGRAM.toBase58()) {
    const inputVault = pool.baseMint === SOL_MINT ? pool.baseVault : pool.quoteVault;
    const outputVault = pool.baseMint === mint ? pool.baseVault : pool.quoteVault;
    if (accounts.length < 13 || accounts[3] !== pool.poolAddress || accounts[10] !== SOL_MINT ||
        accounts[11] !== mint || accounts[6] !== inputVault || accounts[7] !== outputVault ||
        bytes.length !== 24 || !bytes.subarray(0,8).equals(RAYDIUM_SWAP_BASE_INPUT)) return false;
    input = bytes.readBigUInt64LE(8); minimum = bytes.readBigUInt64LE(16);
  } else return false;
  return input === stake && minimum >= minOut;
}
