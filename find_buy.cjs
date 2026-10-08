const fs = require('fs');
const content = fs.readFileSync('src/index.ts', 'utf8').split('\n');
const lines = content.map((line, index) => ({ line, index }));
const buys = lines.filter(l => l.line.includes('executeSwap(') && !l.line.includes('outputMint: \'So11111111111111111111111111111111111111112\''));
for (const b of buys) {
  console.log(`--- BUY SWAP LINE ${b.index} ---`);
  console.log(content.slice(Math.max(0, b.index - 10), Math.min(content.length, b.index + 20)).join('\n'));
}
