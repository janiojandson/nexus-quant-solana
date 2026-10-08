const fs = require('fs');
let i = fs.readFileSync('src/index.ts', 'utf8');
const lines = i.split('\n');
const toDelete = lines.findIndex(l => l.includes('return { status: res.status, headers: res.headers, body: await res.json() };'));
if (toDelete !== -1) {
    lines.splice(toDelete, 2); // remove that line and the following one
}
const telemetry = lines.findIndex(l => l.includes('const exitTelemetry = new NonBlockingTelemetry<Awaited<ReturnType<typeof (() => ({} as any))>>>();'));
if (telemetry !== -1) {
    lines[telemetry] = 'const exitTelemetry = new NonBlockingTelemetry<any>();';
}
fs.writeFileSync('src/index.ts', lines.join('\n'));
console.log('Fixed syntax!');
