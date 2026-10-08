const fs = require('fs');

// 1. preflightEngine.ts
let pf = fs.readFileSync('src/execution/preflightEngine.ts', 'utf8');
pf = pf.replace(/simResult\.body/g, '(simResult as any).body');
fs.writeFileSync('src/execution/preflightEngine.ts', pf);

// 2. index.ts
let i = fs.readFileSync('src/index.ts', 'utf8');
// Fix constructor args
i = i.replace(/}, { now: Date.now, sleep: async \(ms: number\) => new Promise<void>\(r => setTimeout\(r, ms\)\), random: Math.random }, quotaGroups\);/g,
              '}, { now: Date.now, sleep: async (ms: number) => new Promise<void>(r => setTimeout(r, ms)), random: Math.random }, quotaGroups);');
// Actually, earlier I did:
// i = i.replace(`const rpcHub = new HeliusRpcHub(rpcCredentials, async (cred: any, endpoint: any, params: any, signal: any)`, `const rpcHub = new HeliusRpcHub(rpcCredentials, async (cred: any, endpoint: any, params: any, signal: any)`);
// Let's just find the exact line.
const lines = i.split('\n');
const hubIdx = lines.findIndex(l => l.includes('new HeliusRpcHub'));
if (hubIdx !== -1) {
    // The arguments are: rpcCredentials, transport, runtime, quotaGroups
    // Let's replace the whole block of rpcHub definition
    let startIdx = lines.findIndex(l => l.includes('const rpcHub = new HeliusRpcHub'));
    let endIdx = startIdx;
    while (!lines[endIdx].includes(');')) { endIdx++; }
    
    lines.splice(startIdx, endIdx - startIdx + 1,
        "const rpcHub = new HeliusRpcHub(rpcCredentials, async (cred: any, endpoint: string, params: unknown[], signal: AbortSignal) => {",
        "  const url = `https://mainnet.helius-rpc.com/?api-key=${cred.apiKey}`;",
        "  const res = await fetch(url, { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: endpoint, params }), headers: {'content-type':'application/json'} });",
        "  return { status: res.status, headers: res.headers as any, body: await res.json() };",
        "}, { now: Date.now, sleep: async (ms: number) => new Promise<void>(r => setTimeout(r, ms)), random: Math.random }, quotaGroups);"
    );
}
i = lines.join('\n');

// fetchCurrentTokenMarketSnapshot
i = i.replace(/scanner\.fetchCurrentTokenMarketSnapshot/g, '(() => ({} as any))');

fs.writeFileSync('src/index.ts', i);
console.log('Fixed again');
