const fs = require('fs');
const content = fs.readFileSync('src/index.ts', 'utf8').split('\n');
for (let i = 0; i < content.length; i++) {
  const line = content[i];
  if (line.includes('jupiterEngine.') || line.includes('execute') || line.includes('scanner.scanSolanaTrends')) {
    // console.log(`${i+1}: ${line.trim()}`);
  }
}

// Let's just output the exact block where `scanner.scanSolanaTrends` is called and where `execute` happens.
const idx = content.findIndex(l => l.includes('scanner.scanSolanaTrends'));
if (idx !== -1) {
  console.log('--- SCANNER LOOP START ---');
  console.log(content.slice(idx - 5, idx + 15).join('\n'));
}

// Find JupiterExecutionEngine
const jupIdx = content.findIndex(l => l.includes('const jupiterEngine'));
if (jupIdx !== -1) {
  console.log('--- JUPITER ENGINE ---');
  console.log(content.slice(jupIdx - 2, jupIdx + 5).join('\n'));
}

// Find execute entry
const execIdx = content.findIndex(l => l.includes('execute') && l.includes('entry'));
if (execIdx !== -1) {
  console.log('--- EXECUTE ENTRY ---');
  console.log(content.slice(execIdx - 5, execIdx + 10).join('\n'));
}
