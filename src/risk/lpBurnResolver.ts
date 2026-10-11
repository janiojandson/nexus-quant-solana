import { PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddressSync } from '@solana/spl-token';

/** Origem do candidato, usada para resolver prova de LP queimada on-chain. */
export type TokenOrigin = 'PUMP_FUN' | 'RAYDIUM' | 'OTHER';

/** Interface mínima do HeliusRpcHub (evita acoplamento de tipos). */
export interface RpcCaller {
  call(work: 'STATE' | 'CRITICAL', method: string, params: unknown[]): Promise<unknown>;
}

const INCINERATOR = new PublicKey('1nc1nerator11111111111111111111111111111111');
const SYSTEM_PROGRAM = new PublicKey('11111111111111111111111111111111');
const RAYDIUM_AMM_V4 = new PublicKey('675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8');
const RAYDIUM_CPMM = new PublicKey('CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C');

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
 * Verifica on-chain se >= 90% do supply de LP está queimado/bloqueado no
 * incinerador (1nc1nerator...) ou no System Program (1111...).
 */
export async function verifyLpBurnOnChain(rpc: RpcCaller, lpMint: PublicKey): Promise<boolean> {
  try {
    const supply = await rpc.call('STATE', 'getTokenSupply', [lpMint.toBase58()]) as {
      value?: { amount?: string };
    };
    const total = BigInt(supply?.value?.amount ?? '0');
    if (total <= 0n) return false;

    const largest = await rpc.call('STATE', 'getTokenLargestAccounts', [lpMint.toBase58()]) as {
      value?: Array<{ address: string; amount: string }>;
    };

    const burnAtas = new Set<string>([
      getAssociatedTokenAddressSync(lpMint, INCINERATOR, true).toBase58(),
      getAssociatedTokenAddressSync(lpMint, SYSTEM_PROGRAM, true).toBase58(),
    ]);

    let burned = 0n;
    for (const acct of (largest?.value ?? [])) {
      if (burnAtas.has(acct.address)) burned += BigInt(acct.amount);
    }
    return burned * 100n >= total * 90n;
  } catch {
    return false;
  }
}

/**
 * Resolve a prova de LP queimada:
 * - PUMP_FUN: queima por construção do protocolo -> true.
 * - RAYDIUM/OTHER: deriva o lpMint da pool e verifica on-chain.
 */
export function createLpBurnResolver(rpc: RpcCaller) {
  return async (mint: string, pairAddress?: string, origin?: TokenOrigin): Promise<boolean> => {
    if (origin === 'PUMP_FUN') return true;
    if (!pairAddress) return false;
    try {
      const acct = await rpc.call('STATE', 'getAccountInfo', [pairAddress, { encoding: 'base64' }]) as {
        value?: { owner: string; data: [string, string] | string } | null;
      };
      const info = acct?.value;
      if (!info) return false;
      const rawData = Array.isArray(info.data) ? info.data[0] : info.data;
      const buf = Buffer.from(rawData, 'base64');
      const lpMint = deriveRaydiumLpMint(buf, info.owner);
      if (!lpMint) return false;
      return await verifyLpBurnOnChain(rpc, lpMint);
    } catch {
      return false;
    }
  };
}
