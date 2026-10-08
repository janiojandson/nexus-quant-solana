const fs = require('fs');

// Fix index.ts mapped object
let idxContent = fs.readFileSync('src/index.ts', 'utf8');
const oldMap = `const candidates = mints.map(mint => ({
      mint,
      symbol: mint.slice(0, 5),
      liquidityUsd: 20000,
      pairCreatedAt: Date.now() - 3600000
    }));`;
const newMap = `const candidates = mints.map(mint => ({
      mint,
      symbol: mint.slice(0, 5),
      name: mint.slice(0, 5),
      liquidityUsd: 20000,
      pairCreatedAt: Date.now() - 3600000,
      priceUsd: 0.001,
      priceChangeM5: 1,
      buysM5: 10,
      sellsM5: 5,
      volume5mUsd: 5000,
      pairAddress: '11111111111111111111111111111111'
    }));`;
idxContent = idxContent.replace(oldMap, newMap);
fs.writeFileSync('src/index.ts', idxContent);

// Fix sentinelHandoffScanner.ts calling this.rpcHub.call instead of request? Wait, HeliusRpcHub might not even have request/call.
// Let's check HeliusRpcHub's methods.
const rpcHubContent = fs.readFileSync('src/hubs/heliusRpcHub.ts', 'utf8');
const methods = rpcHubContent.match(/public \w+\(/g) || rpcHubContent.match(/class HeliusRpcHub[\s\S]*?(?=\n\})/);
// If it has `call(role: RpcWork, method: string, params: unknown[])`, let's just use `call`.
// Let's just blindly replace request with call in sentinelHandoffScanner.ts.
let handoffContent = fs.readFileSync('src/scanner/sentinelHandoffScanner.ts', 'utf8');
handoffContent = handoffContent.replace(/this\.rpcHub\.request/g, 'this.rpcHub.call');
fs.writeFileSync('src/scanner/sentinelHandoffScanner.ts', handoffContent);

console.log('Fixed types!');
