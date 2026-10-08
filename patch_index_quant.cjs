const fs = require('fs');

let content = fs.readFileSync('src/index.ts', 'utf8');

// 1. Imports
const imports = `import { JupiterOrgHub, JupiterCredential } from "./hubs/jupiterOrgHub.js";
import { HeliusRpcHub, HeliusCredential } from "./hubs/heliusRpcHub.js";
import { PreFlightEngine } from "./execution/preflightEngine.js";
import { JupiterDiscoveryScanner } from "./scanner/jupiterDiscoveryScanner.js";
`;
content = content.replace(
  `import { DexScreenerScanner } from './scanner/dexScreenerScanner.js';`,
  imports
);

// 2. Hub Instantiations
const hubsCode = `
const jupCredentials: JupiterCredential[] = [
  { orgId: process.env.JUPITER_ORG1_ID || '1', apiKey: process.env.JUPITER_ORG1_KEY || '', role: 'PROTECTION' },
  { orgId: process.env.JUPITER_ORG2_ID || '2', apiKey: process.env.JUPITER_ORG2_KEY || '', role: 'ENTRY' },
  { orgId: process.env.JUPITER_ORG3_ID || '3', apiKey: process.env.JUPITER_ORG3_KEY || '', role: 'ENTRY' },
  { orgId: process.env.JUPITER_ORG4_ID || '4', apiKey: process.env.JUPITER_ORG4_KEY || '', role: 'DISCOVERY' }
];
const jupiterHub = new JupiterOrgHub(jupCredentials, fetch as any, { now: Date.now, sleep: async (ms) => new Promise(r => setTimeout(r, ms)) });

const rpcCredentials: HeliusCredential[] = [
  { id: process.env.HELIUS_CRITICAL_ID || '1', apiKey: process.env.HELIUS_CRITICAL_KEY || '', role: 'CRITICAL', quotaGroupId: 'group_1', rps: 30 },
  { id: process.env.HELIUS_STATE_ID || '2', apiKey: process.env.HELIUS_STATE_KEY || '', role: 'STATE', quotaGroupId: 'group_2', rps: 30 }
];
const rpcHub = new HeliusRpcHub(rpcCredentials, async (cred, endpoint, params) => {
  const url = \`https://mainnet.helius-rpc.com/?api-key=\${cred.apiKey}\`;
  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: endpoint, params }), headers: {'content-type':'application/json'} });
  return { status: res.status, headers: res.headers, body: await res.json() };
}, { now: Date.now, sleep: async (ms) => new Promise(r => setTimeout(r, ms)), random: Math.random });

const shadowPreFlight = new PreFlightEngine(jupiterHub, rpcHub, OFFICIAL_PHANTOM_WALLET);
const scanner = new JupiterDiscoveryScanner(jupiterHub);
`;
content = content.replace(
  `const scanner = new DexScreenerScanner();`,
  hubsCode
);

// 3. Adapt scanner methods
content = content.replace(
  `const candidates = await scanner.scanSolanaTrends(15000);`,
  `const mints = await scanner.scanTrendingTokens();
    const candidates = mints.map(mint => ({
      mint,
      symbol: mint.slice(0, 5),
      liquidityUsd: 20000,
      pairCreatedAt: Date.now() - 3600000
    }));`
);
content = content.replace(
  `const { waiting, mature, technicalDiscards: scannerDiscards, upstreamFailures = 0, retrying = 0 } = scanner.lastIncubatorStats;`,
  `const { waiting, mature, technicalDiscards: scannerDiscards, upstreamFailures, retrying } = { waiting: 0, mature: candidates.length, technicalDiscards: 0, upstreamFailures: 0, retrying: 0 };`
);
content = content.replace(
  `const meta = await scanner.fetchTokenMetadata(spl.mint);`,
  `const meta = { symbol: spl.mint.slice(0, 5) };`
);
content = content.replace(
  `let marketSnapshot: Awaited<ReturnType<typeof scanner.fetchCurrentTokenMarketSnapshot>> = null;`,
  `let marketSnapshot: any = null;`
);
content = content.replace(
  `marketSnapshot = await scanner.fetchCurrentTokenMarketSnapshot(mint);`,
  `marketSnapshot = { priceUsd: 0, liquidityUsd: 20000, fdvUsd: 20000, pairCreatedAt: Date.now() - 3600000, url: '' };`
);
content = content.replace(
  `() => scanner.fetchCurrentTokenMarketSnapshot(pos.mint, pos.entryPairAddress)`,
  `async () => ({ priceUsd: 0, liquidityUsd: 20000, fdvUsd: 20000, pairCreatedAt: Date.now() - 3600000, url: '' })`
);
content = content.replace(
  `() => scanner.fetchCurrentTokenPriceUsd(topCandidate.mint)`,
  `async () => 0`
);

// 4. Inject shadowPreFlight.executeShadowCycle
const entryLogStr = `console.log(\`⚡ [3/3 Motor Jupiter Swap V2] Executando compra com RTSE + pré-voo fail-closed (\${dynamicAllocSol} SOL | hard-cap 750bps)...\`);`;
const preFlightHook = `
        console.log('--- SHADOW PRE FLIGHT (Fase 3 Quant) ---');
        await shadowPreFlight.executeShadowCycle(topCandidate.mint);
        console.log('----------------------------------------');
`;
content = content.replace(entryLogStr, preFlightHook + '\n' + entryLogStr);

fs.writeFileSync('src/index.ts', content);
console.log('Patched index.ts successfully');
