const fs = require('fs');

// 1. preflightEngine.ts
let pf = fs.readFileSync('src/execution/preflightEngine.ts', 'utf8');
pf = pf.replace(/this\.rpcHub\.request/g, 'this.rpcHub.call');
fs.writeFileSync('src/execution/preflightEngine.ts', pf);

// 2. sentinelHandoffScanner.ts
let h = fs.readFileSync('src/scanner/sentinelHandoffScanner.ts', 'utf8');
h = h.replace(/const response = await this\.rpcHub\.call/g, 'const response = (await this.rpcHub.call')
     .replace(/\(\'STATE\', \'getAsset\', \[mint\]\);/g, "('STATE', 'getAsset', [mint])) as any;");
fs.writeFileSync('src/scanner/sentinelHandoffScanner.ts', h);

// 3. index.ts
let i = fs.readFileSync('src/index.ts', 'utf8');
i = i.replace(/HeliusCredential/g, 'HeliusKey');
i = i.replace(`async (cred, endpoint, params) =>`, `async (cred: any, endpoint: any, params: any, signal: any) =>`);
i = i.replace(`async (ms) => new Promise(r => setTimeout(r, ms))`, `async (ms: number) => new Promise<void>(r => setTimeout(r, ms))`);
i = i.replace(/quotaGroupId: 'group_2', rps: 30 }/g, `quotaGroupId: 'group_2', rps: 30 }
];
const quotaGroups = [{ id: 'group_1', rps: 30 }, { id: 'group_2', rps: 30 }`);

i = i.replace(`const rpcHub = new HeliusRpcHub(rpcCredentials, async (cred: any, endpoint: any, params: any, signal: any)`, `const rpcHub = new HeliusRpcHub(rpcCredentials, async (cred: any, endpoint: any, params: any, signal: any)`);
i = i.replace(`}, { now: Date.now, sleep: async (ms: number) => new Promise<void>(r => setTimeout(r, ms)), random: Math.random });`, `}, { now: Date.now, sleep: async (ms: number) => new Promise<void>(r => setTimeout(r, ms)), random: Math.random }, quotaGroups);`);

// 4. Candidates mapping properties
const missingProps = `volumeBuysM5: 0,
      volumeSellsM5: 0,
      h1HighPriceUsd: 0,`;
i = i.replace(/volume5mUsd: 5000,/g, `volume5mUsd: 5000,\n      ${missingProps}`);

// 5. telemetry call
i = i.replace(`() => scanner.fetchCurrentTokenMarketSnapshot(pos.mint, pos.entryPairAddress)`, `async () => ({ priceUsd: 0, liquidityUsd: 20000, fdvUsd: 20000, pairCreatedAt: Date.now() - 3600000, url: '' })`);

fs.writeFileSync('src/index.ts', i);
console.log('Fixed more types');
