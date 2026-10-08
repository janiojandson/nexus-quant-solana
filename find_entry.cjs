const fs = require('fs');
const content = fs.readFileSync('src/index.ts', 'utf8').split('\n');
const start = content.findIndex(l => l.includes('function') && l.toLowerCase().includes('entry') || l.includes('execute') && l.toLowerCase().includes('entry') || l.includes('jupiterEngine.execute'));
if (start !== -1) {
    console.log(content.slice(Math.max(0, start - 5), start + 30).join('\n'));
} else {
    // search for Jupiter Execution
    const j = content.findIndex(l => l.includes('jupiterEngine.'));
    if (j !== -1) console.log(content.slice(j - 5, j + 30).join('\n'));
}
