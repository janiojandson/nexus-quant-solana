import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import type { ConfirmedPoolEvidence } from '../pump/confirmedPoolReader.js';
import { PUMP_SWAP_PROGRAM, RAYDIUM_CPMM_PROGRAM } from '../pump/confirmedPoolReader.js';
import { ComputeBudgetInstruction, ComputeBudgetProgram, SystemInstruction, SystemProgram,
  TransactionInstruction, PublicKey } from '@solana/web3.js';
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction, createCloseAccountInstruction,
  createSyncNativeInstruction, getAssociatedTokenAddressSync } from '@solana/spl-token';

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

function sameInstruction(actual: TransactionInstruction, expected: TransactionInstruction): boolean {
  return actual.programId.equals(expected.programId) && actual.data.equals(expected.data) &&
    actual.keys.length === expected.keys.length &&
    actual.keys.every((key,index) => key.pubkey.equals(expected.keys[index].pubkey));
}

/** Permits only self-owned ATA preparation and a single exact-stake WSOL wrap/refund.
 * No arbitrary System transfer, SPL approve/transfer, or foreign close is accepted. */
export function validateEntryAuxiliaries(instructions: readonly TransactionInstruction[],
  jupiterIndex: number, taker: string, mint: string, stakeLamports: number,
  declaredPriorityFeeLamports: number): number | null {
  const wallet = new PublicKey(taker), target = new PublicKey(mint), wsol = new PublicKey(SOL_MINT);
  const wsolAta = getAssociatedTokenAddressSync(wsol,wallet,true);
  const targetAta = getAssociatedTokenAddressSync(target,wallet,true);
  const allowedAta = new Map([['wsol',createAssociatedTokenAccountIdempotentInstruction(wallet,wsolAta,wallet,wsol)],
    ['target',createAssociatedTokenAccountIdempotentInstruction(wallet,targetAta,wallet,target)]]);
  const sync = createSyncNativeInstruction(wsolAta);
  const close = createCloseAccountInstruction(wsolAta,wallet,wallet);
  const seen = new Set<string>();
  let wrapped = false, synced = false, closed = false;
  let computeUnits: number | null = null, computePrice: bigint | null = null;
  for (const [index,ix] of instructions.entries()) {
    if (index === jupiterIndex) continue;
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (index > jupiterIndex) return null;
      try {
        const kind = ComputeBudgetInstruction.decodeInstructionType(ix);
        if (kind === 'SetComputeUnitLimit' && computeUnits === null) {
          const units = ComputeBudgetInstruction.decodeSetComputeUnitLimit(ix).units;
          if (!Number.isSafeInteger(units) || units <= 0 || units > 1_400_000 ||
              !sameInstruction(ix,ComputeBudgetProgram.setComputeUnitLimit({units}))) return null;
          computeUnits = units; continue;
        }
        if (kind === 'SetComputeUnitPrice' && computePrice === null) {
          const price = BigInt(ComputeBudgetInstruction.decodeSetComputeUnitPrice(ix).microLamports);
          if (price < 0n || !sameInstruction(ix,ComputeBudgetProgram.setComputeUnitPrice({microLamports:price}))) return null;
          computePrice = price; continue;
        }
      } catch { return null; }
      return null;
    }
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      if (index > jupiterIndex) return null;
      const entry = [...allowedAta].find(([,expected])=>sameInstruction(ix,expected));
      if (!entry || seen.has(entry[0])) return null;
      seen.add(entry[0]); continue;
    }
    if (ix.programId.equals(SystemProgram.programId)) {
      if (index > jupiterIndex || wrapped || !seen.has('wsol')) return null;
      try {
        const decoded = SystemInstruction.decodeTransfer(ix);
        if (!decoded.fromPubkey.equals(wallet) || !decoded.toPubkey.equals(wsolAta) ||
            decoded.lamports !== BigInt(stakeLamports)) return null;
      } catch { return null; }
      wrapped = true; continue;
    }
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      if (sameInstruction(ix,sync) && index < jupiterIndex && wrapped && !synced) {
        synced = true; continue;
      }
      if (sameInstruction(ix,close) && index > jupiterIndex && synced && !closed) {
        closed = true; continue;
      }
      return null;
    }
    return null;
  }
  if (wrapped !== synced || (seen.has('wsol') && !wrapped) || (closed && !wrapped)) return null;
  if (computePrice !== null && computePrice > 0n) {
    if (computeUnits === null || !Number.isSafeInteger(declaredPriorityFeeLamports) ||
        declaredPriorityFeeLamports < 0 ||
        (BigInt(computeUnits) * computePrice + 999_999n) / 1_000_000n > BigInt(declaredPriorityFeeLamports))
      return null;
  }
  return seen.size;
}

interface InnerInstruction {programId?: unknown;accounts?: unknown;data?: unknown;stackHeight?: unknown}
interface InnerGroup {index?: unknown;instructions?: unknown}
/** Only the documented, single-leg PumpSwap/CPMM CPI shapes are supported. */
export function hasBoundSwapCpi(groups: unknown, parentIndex: number,
  pool: ConfirmedPoolEvidence, mint: string, taker: string, stake: bigint, minOut: bigint): boolean {
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
  const user = new PublicKey(taker);
  const inputAta = getAssociatedTokenAddressSync(new PublicKey(SOL_MINT),user,true).toBase58();
  const outputAta = getAssociatedTokenAddressSync(new PublicKey(mint),user,true).toBase58();
  let bytes: Buffer;
  try { bytes = Buffer.from(bs58.decode(ix.data)); } catch { return false; }
  let input: bigint, minimum: bigint;
  if (pool.programId === PUMP_SWAP_PROGRAM.toBase58()) {
    if (pool.baseMint !== mint || pool.quoteMint !== SOL_MINT || accounts.length < 9 ||
        accounts[0] !== pool.poolAddress || accounts[3] !== mint || accounts[4] !== SOL_MINT ||
        accounts[5] !== outputAta || accounts[6] !== inputAta ||
        accounts[7] !== pool.baseVault || accounts[8] !== pool.quoteVault ||
        bytes.length !== 25 || !bytes.subarray(0,8).equals(PUMP_BUY_EXACT_QUOTE_IN) || bytes[24] > 1) return false;
    input = bytes.readBigUInt64LE(8); minimum = bytes.readBigUInt64LE(16);
  } else if (pool.programId === RAYDIUM_CPMM_PROGRAM.toBase58()) {
    const inputVault = pool.baseMint === SOL_MINT ? pool.baseVault : pool.quoteVault;
    const outputVault = pool.baseMint === mint ? pool.baseVault : pool.quoteVault;
    if (accounts.length < 13 || accounts[3] !== pool.poolAddress || accounts[10] !== SOL_MINT ||
        accounts[4] !== inputAta || accounts[5] !== outputAta ||
        accounts[11] !== mint || accounts[6] !== inputVault || accounts[7] !== outputVault ||
        bytes.length !== 24 || !bytes.subarray(0,8).equals(RAYDIUM_SWAP_BASE_INPUT)) return false;
    input = bytes.readBigUInt64LE(8); minimum = bytes.readBigUInt64LE(16);
  } else return false;
  return input === stake && minimum >= minOut;
}
