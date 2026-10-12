import { PublicKey } from '@solana/web3.js';

/** Origem do candidato, usada para resolver prova de LP queimada on-chain. */
export type TokenOrigin = 'PUMP_FUN' | 'RAYDIUM' | 'OTHER';

/** Interface mínima do HeliusRpcHub (evita acoplamento de tipos). */
export interface RpcCaller {
  call(work: 'STATE' | 'CRITICAL', method: string, params: unknown[]): Promise<unknown>;
}

const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');
// Destino de queima comum. É ON-curve, então entra explicitamente na prova.
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');

/**
 * Deriva o mint de LP a partir dos bytes da conta da pool Raydium.
 * - AMM V4: 752 bytes, lpMint em 464..496.
 * - CPMM:   >= 168 bytes, lpMint em 128..160.
 */
export function deriveRaydiumLpMint(accountData: Uint8Array, owner: string): PublicKey | null {
  const ownerPk = new PublicKey(owner);
  if (ownerPk.equals(RAYDIUM_AMM_V4)) {
    if (accountData.length < 496) return null;
    return new PublicKey(accountData.subarray(464, 496));
  }
  if (ownerPk.equals(RAYDIUM_CPMM)) {
    if (accountData.length < 160) return null;
    return new PublicKey(accountData.subarray(128, 160));
  }
  return null;
}

/**
 * Lê o owner (offset 32..64) de uma ATA de token, ou null se a conta não
 * existir / não for legível.
 */
async function ataOwner(rpc: RpcCaller, address: string): Promise<PublicKey | null> {
  const acct = await rpc.call('STATE', 'getAccountInfo', [address, { encoding: 'base64' }]) as {
    value?: { data: [string, string] | string } | null;
  };
  const info = acct?.value;
  if (!info) return null;
  const rawData = Array.isArray(info.data) ? info.data[0] : info.data;
  const buf = Buffer.from(rawData, 'base64');
  if (buf.length < 64) return null;
  return new PublicKey(buf.subarray(32, 64));
}

/**
 * Verifica on-chain se >= 90% do supply de LP está imobilizado: queimado
 * (incinerador/System Program) ou trancado em locker/PDAs. A heurística é
 * estrutural — todo endereço OFF-curve é um PDA sem chave privada e, portanto,
 * não consegue drenar a LP. Cobre incinerador, Streamflow, PinkLock e lockers
 * genéricos sem hardcodar program IDs.
 */
export async function verifyLpLockedOrBurnedOnChain(rpc: RpcCaller, lpMint: PublicKey): Promise<boolean> {
  try {
    const supply = await rpc.call('STATE', 'getTokenSupply', [lpMint.toBase58()]) as {
      value?: { amount?: string };
    };
    const total = BigInt(supply?.value?.amount ?? '0');
    if (total <= 0n) return false;

    const largest = await rpc.call('STATE', 'getTokenLargestAccounts', [lpMint.toBase58()]) as {
      value?: Array<{ address: string; amount: string }>;
    };

    let lockedOrBurned = 0n;
    for (const acct of (largest?.value ?? [])) {
      const owner = await ataOwner(rpc, acct.address);
      // OFF-curve = PDA sem chave privada (locker/incinerador); System Program é ON-curve
      // mas é um destino de queima comum, então entra explicitamente.
      if (owner && (!PublicKey.isOnCurve(owner.toBytes()) || owner.equals(SYSTEM_PROGRAM))) {
        lockedOrBurned += BigInt(acct.amount);
        // Short-circuit: os holders vêm em ordem decrescente; atinge 90% => provado.
        if (lockedOrBurned * 100n >= total * 90n) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Alias de compatibilidade para a prova de queima (F-13.5): a prova agora é
 * de "trancada OU queimada", então o nome antigo aponta para a nova função.
 */
export const verifyLpBurnOnChain = verifyLpLockedOrBurnedOnChain;

/**
 * Resolve a prova de LP imobilizada (tri-state):
 * - PUMP_FUN: queima por construção do protocolo -> true.
 * - true:  >= 90% locked/burned on-chain.
 * - false: verificado como NÃO imobilizada (LP em EOAs drenáveis).
 * - undefined: não foi possível determinar (sem par, pool não-Raydium, RPC falhou).
 */
export function createLpBurnResolver(rpc: RpcCaller) {
  return async (mint: string, pairAddress?: string, origin?: TokenOrigin): Promise<boolean | undefined> => {
    if (origin === 'PUMP_FUN') return true;
    if (!pairAddress) return undefined;
    try {
      const acct = await rpc.call('STATE', 'getAccountInfo', [pairAddress, { encoding: 'base64' }]) as {
        value?: { owner: string; data: [string, string] | string } | null;
      };
      const info = acct?.value;
      if (!info) return undefined;
      const rawData = Array.isArray(info.data) ? info.data[0] : info.data;
      const buf = Buffer.from(rawData, 'base64');
      const lpMint = deriveRaydiumLpMint(buf, info.owner);
      if (!lpMint) return undefined;
      return await verifyLpLockedOrBurnedOnChain(rpc, lpMint);
    } catch {
      return undefined;
    }
  };
}
