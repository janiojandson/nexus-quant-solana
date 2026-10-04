const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const auditDir = 'C:/Users/Janio/.codex/visualizations/2026/10/04/01a105c8-a305-7c91-81b7-f8302b81ce54/solana-audit';
const outBase = path.join(__dirname, '../test/fixtures/incidents');

function sha256Buf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sha256File(filePath) {
  return sha256Buf(fs.readFileSync(filePath));
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Universal Secret Check
const FORBIDDEN_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /xprv[a-zA-Z0-9]{100,}/,
  /[a-zA-Z0-9_-]{20,}:[a-zA-Z0-9_-]{35,}/, // Bot tokens
  /https?:\/\/[^:]+:[^@]+@/, // Credentials in URL
  /postgresql:\/\/[^:]+:[^@]+@/,
  /ghp_[a-zA-Z0-9]{36}/,
  /railway_[a-zA-Z0-9]{32,}/
];

function verifyNoSecrets(str, label) {
  for (const pat of FORBIDDEN_PATTERNS) {
    if (pat.test(str)) {
      throw new Error(`CRITICAL: Forbidden secret pattern detected in ${label}`);
    }
  }
}

// -------------------------------------------------------------
// 1. Build Tesla
// -------------------------------------------------------------
function buildTesla() {
  const incidentDir = path.join(outBase, 'tesla');
  ensureDir(incidentDir);

  const pathLines = fs.readFileSync(path.join(auditDir, 'tesla-path.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  const crashLines = fs.readFileSync(path.join(auditDir, 'tesla-crash.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  const partialLines = fs.readFileSync(path.join(auditDir, 'tesla-partial.jsonl'), 'utf8').trim().split('\n').filter(Boolean);

  // Map crash events by ms
  const crashMsMap = new Map();
  crashLines.forEach(l => {
    const o = JSON.parse(l);
    const ms = Date.parse(o.timestamp);
    if (!crashMsMap.has(ms)) crashMsMap.set(ms, []);
    crashMsMap.get(ms).push(o);
  });

  const partialMsMap = new Map();
  partialLines.forEach(l => {
    const o = JSON.parse(l);
    const ms = Date.parse(o.timestamp);
    if (!partialMsMap.has(ms)) partialMsMap.set(ms, []);
    partialMsMap.get(ms).push(o);
  });

  const observations = [];
  pathLines.forEach(l => {
    const o = JSON.parse(l);
    const wallMs = Date.parse(o.timestamp);
    const msg = o.message;

    const pnlMatch = msg.match(/Sensor PnL:\s*([+-]?[\d.]+)%/);
    const peakMatch = msg.match(/Pico:\s*([+-]?[\d.]+)%/);
    const isPartialRunner = msg.includes('SUPER RUNNER') || msg.includes('50%');
    const pnlPct = pnlMatch ? parseFloat(pnlMatch[1]) : null;
    const peakPct = peakMatch ? parseFloat(peakMatch[1]) : null;

    let decision = 'HOLD';
    let reason = null;
    let executableValue = null;

    // Check partial trigger
    const partialExtras = partialMsMap.get(wallMs) || [];
    partialExtras.forEach(ext => {
      if (ext.message.includes('PARTIAL_TAKE_PROFIT_50')) {
        decision = 'PARTIAL_TAKE_PROFIT_50';
        reason = 'PARTIAL_TAKE_PROFIT_50';
        const valMatch = ext.message.match(/Valor:\s*([\d.]+)\s*SOL/);
        if (valMatch) executableValue = parseFloat(valMatch[1]);
      }
    });

    // Check crash trigger
    const crashExtras = crashMsMap.get(wallMs) || [];
    crashExtras.forEach(ext => {
      if (ext.message.includes('TRAILING_STOP')) {
        decision = 'TRAILING_STOP';
        reason = 'TRAILING_STOP';
        const valMatch = ext.message.match(/Valor:\s*([\d.]+)\s*SOL/);
        if (valMatch) executableValue = parseFloat(valMatch[1]);
      }
    });

    const tokenAmount = isPartialRunner ? '2187913065' : '4375826130';

    observations.push({
      timestampWallMs: wallMs,
      monotonicOffsetMs: null,
      slot: null,
      source: 'SNIPER_MONITOR',
      mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
      poolId: '7xZSFrmsrZ2NqLN76wzQicVtdV877PsCLUAnHvXMGsdW',
      tokenAmountAtomic: tokenAmount,
      jupiterExecutableValueSol: executableValue,
      observablePrice: null,
      reserveBase: null,
      reserveQuote: null,
      liquiditySol: null,
      positionVersion: null,
      partialTaken: isPartialRunner,
      pnlPct: pnlPct,
      peakPct: peakPct,
      decision: decision,
      reason: reason
    });
  });

  const obsJsonl = observations.map(o => JSON.stringify(o)).join('\n') + '\n';
  verifyNoSecrets(obsJsonl, 'tesla/observations.jsonl');
  fs.writeFileSync(path.join(incidentDir, 'observations.jsonl'), obsJsonl, 'utf8');

  const transactions = [
    {
      signature: '39ewp5zPn2Yt2R2XKPcYjeYzfEUaCbaYxrUvjeKAcxDXurNmHkax2NQgt7Tf2ohsGfzPGETVjNZcEyTiJDp1QEb4',
      slot: 452771765,
      blockTime: 1790987362,
      time: '2026-10-03T00:29:22.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: -0.021520406,
      tokenDelta: 4375826130,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'ENTRY_BUY',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '412iyd7rXdw22UFjZRKwpWgD5m8d13e9wpqvAZrWduwxpXJuHtxw8taWMHeesnZCrtQQMn5CRwCnFRnLLGqcDacZ',
      slot: 452774049,
      blockTime: 1790987973,
      time: '2026-10-03T00:39:33.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.013524731,
      tokenDelta: -2187913065,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'PARTIAL_SELL',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '2ti4qD2YffXcJnTj5swzvgoNGYd798qQD6gECvP88UfAcacTY53mmWgoH7GzLsaqSveQ3Y6a7BS18ruyv4FX8Hye',
      slot: 452790087,
      blockTime: 1790992260,
      time: '2026-10-03T01:51:00.000Z',
      programId: null,
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: null,
      tokenDelta: null,
      reserveBefore: 605.208278216,
      reserveAfter: 1.373794508,
      transactionType: 'POOL_CRASH_SELL',
      evidenceSource: 'pool-summary.json'
    },
    {
      signature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN',
      slot: 452790108,
      blockTime: 1790992266,
      time: '2026-10-03T01:51:06.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.000031115,
      tokenDelta: -2187913065,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'FINAL_SELL',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '5Gpmdndk7j5ZCueBYnthCJqH1JkCWiJZu6o83fraJXRVW8sVmi4KpfDD2yoPqeahLkPU8S8xcKPmze7KtMomAfw9',
      slot: 452790116,
      blockTime: 1790992268,
      time: '2026-10-03T01:51:08.000Z',
      programId: null,
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.001508840,
      tokenDelta: 0,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'ATA_CLOSE',
      evidenceSource: 'chain-summary.json'
    }
  ];
  fs.writeFileSync(path.join(incidentDir, 'transactions.json'), JSON.stringify(transactions, null, 2), 'utf8');

  const expected = {
    incidentId: 'TESLA',
    taxonomy: ['PRICE_GAP'],
    capitalSwapSol: 0.02,
    partialTaken: true,
    partialProceedsSol: 0.013533348,
    finalProceedsSol: 0.000041149,
    netLiquidSol: -0.006455720,
    netReturnPct: -32.2786,
    boughtTokensAtomic: 4375826130,
    partialTokensAtomic: 2187913065,
    finalTokensAtomic: 2187913065,
    peakObservedPnlPct: 376.47,
    lastGoodObservationPnlPct: 376.26,
    firstDeterioratedPnlPct: -99.59,
    poolDropReservePreSol: 605.208278216,
    poolDropReservePostSol: 1.373794508,
    poolDropPct: -99.7730,
    poolCrashTxSignature: '2ti4qD2YffXcJnTj5swzvgoNGYd798qQD6gECvP88UfAcacTY53mmWgoH7GzLsaqSveQ3Y6a7BS18ruyv4FX8Hye',
    finalExitTxSignature: '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN',
    fillVsSignalQuotePct: 0.0,
    firstBadObservationAlreadyDeteriorated: true,
    partialOccurredBeforeCrash: true,
    finalFillConfirmed: true
  };
  fs.writeFileSync(path.join(incidentDir, 'expected.json'), JSON.stringify(expected, null, 2), 'utf8');

  const sourceFiles = [
    { file: 'tesla-path.jsonl', bytes: 816337, sha256: sha256File(path.join(auditDir, 'tesla-path.jsonl')), recordCount: 2807 },
    { file: 'tesla-crash.jsonl', bytes: 41712, sha256: sha256File(path.join(auditDir, 'tesla-crash.jsonl')), recordCount: 166 },
    { file: 'tesla-entry.jsonl', bytes: 47712, sha256: sha256File(path.join(auditDir, 'tesla-entry.jsonl')), recordCount: 203 },
    { file: 'tesla-partial.jsonl', bytes: 14736, sha256: sha256File(path.join(auditDir, 'tesla-partial.jsonl')), recordCount: 63 },
    { file: 'chain-summary.json', bytes: 21992, sha256: sha256File(path.join(auditDir, 'chain-summary.json')), recordCount: 33 },
    { file: 'pool-summary.json', bytes: 23828, sha256: sha256File(path.join(auditDir, 'pool-summary.json')), recordCount: 15 },
    { file: 'database.json', bytes: 31326, sha256: sha256File(path.join(auditDir, 'database.json')), recordCount: 12 }
  ];

  const manifest = {
    incidentId: 'TESLA',
    tokenSymbol: 'Tesla',
    mint: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
    poolId: '7xZSFrmsrZ2NqLN76wzQicVtdV877PsCLUAnHvXMGsdW',
    sourceFiles: sourceFiles,
    sourceSha256: sha256Buf(Buffer.from(JSON.stringify(sourceFiles))),
    sourceRecordCount: 2807,
    auditVersion: '2026-10-04',
    firstTimestamp: '2026-10-03T00:29:22.000Z',
    lastTimestamp: '2026-10-03T01:51:09.518Z',
    knownDeploymentSha: '9157d42',
    dataCompleteness: 'HIGH_PAGINATED_SERIES',
    knownLimitations: [
      'Sub-millisecond internal latency not captured in legacy logs',
      'Monotonic offsets and positionVersion null in legacy system',
      'Dex liquidity numbers reflect third-party aggregation delay'
    ]
  };
  fs.writeFileSync(path.join(incidentDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

// -------------------------------------------------------------
// 2. Build SSI
// -------------------------------------------------------------
function buildSSI() {
  const incidentDir = path.join(outBase, 'ssi');
  ensureDir(incidentDir);

  const pathLines = fs.readFileSync(path.join(auditDir, 'ssi-path.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  const crashLines = fs.readFileSync(path.join(auditDir, 'ssi-crash.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  const partialLines = fs.readFileSync(path.join(auditDir, 'ssi-partial.jsonl'), 'utf8').trim().split('\n').filter(Boolean);

  const crashMsMap = new Map();
  crashLines.forEach(l => {
    const o = JSON.parse(l);
    const ms = Date.parse(o.timestamp);
    if (!crashMsMap.has(ms)) crashMsMap.set(ms, []);
    crashMsMap.get(ms).push(o);
  });

  const partialMsMap = new Map();
  partialLines.forEach(l => {
    const o = JSON.parse(l);
    const ms = Date.parse(o.timestamp);
    if (!partialMsMap.has(ms)) partialMsMap.set(ms, []);
    partialMsMap.get(ms).push(o);
  });

  const observations = [];
  pathLines.forEach(l => {
    const o = JSON.parse(l);
    const wallMs = Date.parse(o.timestamp);
    const msg = o.message;

    const pnlMatch = msg.match(/Sensor PnL:\s*([+-]?[\d.]+)%/);
    const peakMatch = msg.match(/Pico:\s*([+-]?[\d.]+)%/);
    const isPartialRunner = msg.includes('SUPER RUNNER') || msg.includes('50%');
    const pnlPct = pnlMatch ? parseFloat(pnlMatch[1]) : null;
    const peakPct = peakMatch ? parseFloat(peakMatch[1]) : null;

    let decision = 'HOLD';
    let reason = null;
    let executableValue = null;

    const partialExtras = partialMsMap.get(wallMs) || [];
    partialExtras.forEach(ext => {
      if (ext.message.includes('PARTIAL_TAKE_PROFIT')) {
        decision = 'PARTIAL_TAKE_PROFIT_50';
        reason = 'PARTIAL_TAKE_PROFIT_50';
        const valMatch = ext.message.match(/Valor:\s*([\d.]+)\s*SOL/);
        if (valMatch) executableValue = parseFloat(valMatch[1]);
      }
    });

    const crashExtras = crashMsMap.get(wallMs) || [];
    crashExtras.forEach(ext => {
      if (ext.message.includes('TRAILING_STOP')) {
        decision = 'TRAILING_STOP';
        reason = 'TRAILING_STOP';
        const valMatch = ext.message.match(/Valor:\s*([\d.]+)\s*SOL/);
        if (valMatch) executableValue = parseFloat(valMatch[1]);
      }
    });

    const tokenAmount = isPartialRunner ? '2723751210' : '5447502420';

    observations.push({
      timestampWallMs: wallMs,
      monotonicOffsetMs: null,
      slot: null,
      source: 'SNIPER_MONITOR',
      mint: 'Da6ptrSSQWxGtyQwYpZSgMEZbm5Z9jc1ACjife9kpump',
      poolId: '8hPEGeDiQRZazBNswiXcnMYee8LJwyAxPRhDQuKSuS98',
      tokenAmountAtomic: tokenAmount,
      jupiterExecutableValueSol: executableValue,
      observablePrice: null,
      reserveBase: null,
      reserveQuote: null,
      liquiditySol: null,
      positionVersion: null,
      partialTaken: isPartialRunner,
      pnlPct: pnlPct,
      peakPct: peakPct,
      decision: decision,
      reason: reason
    });
  });

  const obsJsonl = observations.map(o => JSON.stringify(o)).join('\n') + '\n';
  verifyNoSecrets(obsJsonl, 'ssi/observations.jsonl');
  fs.writeFileSync(path.join(incidentDir, 'observations.jsonl'), obsJsonl, 'utf8');

  const transactions = [
    {
      signature: '4Vq6ahBPh8RdnAp84xLEze4igS3jg8bwgYWxVS3Goy2UqY6TenkPDymizNNMQESriFnoXh5HXM3z4bkZds5YqkoT',
      slot: 453157547,
      blockTime: 1791090459,
      time: '2026-10-04T05:07:39.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: -0.023346533,
      tokenDelta: 5447502420,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'ENTRY_BUY',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '4nFkR4PfUgMvtxJ6cou6TsySmNVHDJ5Z3ZAx7KGnisz2cmyJ1TpVnyi6gLEZZSMBPhemEEBkuFr42veDHxVGuGRr',
      slot: 453159903,
      blockTime: 1791091086,
      time: '2026-10-04T05:18:06.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.014846753,
      tokenDelta: -2723751210,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'PARTIAL_SELL',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '2UJoZzLXErPHjWLsbBcdhFfbwRB8zRLHHvnmPnR3uqKffUjiENe2eZwUgFjAmxediX6iRW9m641ogYT4V55ihPML',
      slot: 453173809,
      blockTime: 1791094796,
      time: '2026-10-04T06:19:56.000Z',
      programId: null,
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: null,
      tokenDelta: null,
      reserveBefore: 863.876225463,
      reserveAfter: 101.581357745,
      transactionType: 'POOL_CRASH_SELL',
      evidenceSource: 'pool-crash-transactions.json'
    },
    {
      signature: '4mMBHLwEBk7fwV3zp7w8CyfCWzff1H9BaDJVWEmAL2TPVsHffAJHMKrNkupErsQL4QZ4keZQULBuMZxY4EBeQNAT',
      slot: 453173820,
      blockTime: 1791094799,
      time: '2026-10-04T06:19:59.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.002130797,
      tokenDelta: -2723751210,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'FINAL_SELL',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '5ngSyjbQ32QfncFu3dn9AwsvuUhftbqga3p7LuAkANcv4486nkd9TeLreTfT7QwvqVcrDcfk6sSWfTaxLmDnZng7',
      slot: 453173832,
      blockTime: 1791094802,
      time: '2026-10-04T06:20:02.000Z',
      programId: null,
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.001508840,
      tokenDelta: 0,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'ATA_CLOSE',
      evidenceSource: 'chain-summary.json'
    }
  ];
  fs.writeFileSync(path.join(incidentDir, 'transactions.json'), JSON.stringify(transactions, null, 2), 'utf8');

  const expected = {
    incidentId: 'SSI',
    taxonomy: ['PRICE_GAP'],
    capitalSwapSol: 0.021826256,
    partialTaken: true,
    partialProceedsSol: 0.014854168,
    finalProceedsSol: 0.002137281,
    netLiquidSol: -0.004860143,
    netReturnPct: -22.2674,
    boughtTokensAtomic: 5447502420,
    partialTokensAtomic: 2723751210,
    finalTokensAtomic: 2723751210,
    peakObservedPnlPct: 986.98,
    firstDeterioratedPnlPct: -80.46,
    poolDropReservePreSol: 863.876225463,
    poolDropReservePostSol: 101.581357745,
    poolDropPct: -88.2412,
    poolCrashTxSignature: '2UJoZzLXErPHjWLsbBcdhFfbwRB8zRLHHvnmPnR3uqKffUjiENe2eZwUgFjAmxediX6iRW9m641ogYT4V55ihPML',
    finalExitTxSignature: '4mMBHLwEBk7fwV3zp7w8CyfCWzff1H9BaDJVWEmAL2TPVsHffAJHMKrNkupErsQL4QZ4keZQULBuMZxY4EBeQNAT',
    fillVsSignalQuotePct: 0.2171,
    firstBadObservationAlreadyDeteriorated: true,
    partialOccurredBeforeCrash: true,
    finalFillConfirmed: true
  };
  fs.writeFileSync(path.join(incidentDir, 'expected.json'), JSON.stringify(expected, null, 2), 'utf8');

  const sourceFiles = [
    { file: 'ssi-path.jsonl', bytes: 831715, sha256: sha256File(path.join(auditDir, 'ssi-path.jsonl')), recordCount: 2891 },
    { file: 'ssi-crash.jsonl', bytes: 25106, sha256: sha256File(path.join(auditDir, 'ssi-crash.jsonl')), recordCount: 100 },
    { file: 'ssi-entry.jsonl', bytes: 43271, sha256: sha256File(path.join(auditDir, 'ssi-entry.jsonl')), recordCount: 182 },
    { file: 'ssi-partial.jsonl', bytes: 8690, sha256: sha256File(path.join(auditDir, 'ssi-partial.jsonl')), recordCount: 37 },
    { file: 'chain-summary.json', bytes: 21992, sha256: sha256File(path.join(auditDir, 'chain-summary.json')), recordCount: 33 },
    { file: 'pool-crash-transactions.json', bytes: 1290495, sha256: sha256File(path.join(auditDir, 'pool-crash-transactions.json')), recordCount: 2 },
    { file: 'database.json', bytes: 31326, sha256: sha256File(path.join(auditDir, 'database.json')), recordCount: 12 }
  ];

  const manifest = {
    incidentId: 'SSI',
    tokenSymbol: 'SSI',
    mint: 'Da6ptrSSQWxGtyQwYpZSgMEZbm5Z9jc1ACjife9kpump',
    poolId: '8hPEGeDiQRZazBNswiXcnMYee8LJwyAxPRhDQuKSuS98',
    sourceFiles: sourceFiles,
    sourceSha256: sha256Buf(Buffer.from(JSON.stringify(sourceFiles))),
    sourceRecordCount: 2891,
    auditVersion: '2026-10-04',
    firstTimestamp: '2026-10-04T05:07:39.000Z',
    lastTimestamp: '2026-10-04T06:20:03.805Z',
    knownDeploymentSha: '7904d9c',
    dataCompleteness: 'HIGH_PAGINATED_SERIES',
    knownLimitations: [
      'Sub-millisecond internal latency not captured in legacy logs',
      'Monotonic offsets and positionVersion null in legacy system',
      'Dex liquidity numbers reflect third-party aggregation delay'
    ]
  };
  fs.writeFileSync(path.join(incidentDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

// -------------------------------------------------------------
// 3. Build Mr Beast
// -------------------------------------------------------------
function buildMrBeast() {
  const incidentDir = path.join(outBase, 'mr-beast');
  ensureDir(incidentDir);

  const pathLines = fs.readFileSync(path.join(auditDir, 'beast-path.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
  const crashLines = fs.readFileSync(path.join(auditDir, 'beast-crash.jsonl'), 'utf8').trim().split('\n').filter(Boolean);

  const crashMsMap = new Map();
  crashLines.forEach(l => {
    const o = JSON.parse(l);
    const ms = Date.parse(o.timestamp);
    if (!crashMsMap.has(ms)) crashMsMap.set(ms, []);
    crashMsMap.get(ms).push(o);
  });

  const observations = [];
  pathLines.forEach(l => {
    const o = JSON.parse(l);
    const wallMs = Date.parse(o.timestamp);
    const msg = o.message;

    const pnlMatch = msg.match(/Sensor PnL:\s*([+-]?[\d.]+)%/);
    const peakMatch = msg.match(/Pico:\s*([+-]?[\d.]+)%/);
    const isPartialRunner = msg.includes('SUPER RUNNER') || msg.includes('50%');
    const pnlPct = pnlMatch ? parseFloat(pnlMatch[1]) : null;
    const peakPct = peakMatch ? parseFloat(peakMatch[1]) : null;

    let decision = 'HOLD';
    let reason = null;
    let executableValue = null;

    const crashExtras = crashMsMap.get(wallMs) || [];
    crashExtras.forEach(ext => {
      if (ext.message.includes('PARTIAL_TAKE_PROFIT')) {
        decision = 'PARTIAL_TAKE_PROFIT_50';
        reason = 'PARTIAL_TAKE_PROFIT_50';
        const valMatch = ext.message.match(/Valor:\s*([\d.]+)\s*SOL/);
        if (valMatch) executableValue = parseFloat(valMatch[1]);
      } else if (ext.message.includes('TRAILING_STOP')) {
        decision = 'TRAILING_STOP';
        reason = 'TRAILING_STOP';
        const valMatch = ext.message.match(/Valor:\s*([\d.]+)\s*SOL/);
        if (valMatch) executableValue = parseFloat(valMatch[1]);
      }
    });

    const tokenAmount = isPartialRunner ? '2753142187' : '5506284374';

    observations.push({
      timestampWallMs: wallMs,
      monotonicOffsetMs: null,
      slot: null,
      source: 'SNIPER_MONITOR',
      mint: '8nzyZHNFhbpZrf6VpvJPenbc6WrhW6isidrbKAgTMyJ1',
      poolId: 'E3KkCcPjdBd7Qf5WqaKUuwZytyNXvUt7MinCZExdC7Yy',
      tokenAmountAtomic: tokenAmount,
      jupiterExecutableValueSol: executableValue,
      observablePrice: null,
      reserveBase: null,
      reserveQuote: null,
      liquiditySol: null,
      positionVersion: null,
      partialTaken: isPartialRunner,
      pnlPct: pnlPct,
      peakPct: peakPct,
      decision: decision,
      reason: reason
    });
  });

  const obsJsonl = observations.map(o => JSON.stringify(o)).join('\n') + '\n';
  verifyNoSecrets(obsJsonl, 'mr-beast/observations.jsonl');
  fs.writeFileSync(path.join(incidentDir, 'observations.jsonl'), obsJsonl, 'utf8');

  const transactions = [
    {
      signature: 'nn7biyBdbtjHS7WPUxEC2xEZGKdgnwctJBB84k2z2o683Sqyuy6fi96cBDFfhpnVEf1mHuZJxTbTP1K5wfbgpXZ',
      slot: 453145725,
      blockTime: 1791087309,
      time: '2026-10-04T04:15:09.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: -0.024251102,
      tokenDelta: 5506284374,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'ENTRY_BUY',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '42gAi5jChf7wSZzCc6MnRcai6qKjQmj1keETL3Ecf5bzpb56ubCT5pyHUgmpsEEjWPRnUV9sXB3AtQCed5QFKhFn',
      slot: 453146510,
      blockTime: 1791087517,
      time: '2026-10-04T04:18:37.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.015394862,
      tokenDelta: -2753142187,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'PARTIAL_SELL',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '59U3QJFGEAEyzLUGDKeEAcd2ryJEZv9hcwQV9DSk8WySXiUKqKZzAcgsSbSyBRqx973Hm69bYYKpste7sAPd8SdA',
      slot: 453146589,
      blockTime: 1791087538,
      time: '2026-10-04T04:18:58.000Z',
      programId: null,
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: null,
      tokenDelta: null,
      reserveBefore: 302.822274317,
      reserveAfter: 86.084900580,
      transactionType: 'POOL_CRASH_SELL',
      evidenceSource: 'pool-crash-transactions.json'
    },
    {
      signature: 'syypYLfEjBmNcQjcBQjfE6Gt3oDw9NBtPQJYgPBrz3TSGcCXGiLknyBJnQD9Qtoit2C8uQohVeiStDgnWuP9yQJ',
      slot: 453146599,
      blockTime: 1791087541,
      time: '2026-10-04T04:19:01.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.001648827,
      tokenDelta: -2753142187,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'FINAL_SELL',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '48FkYDnof1kM8wmB5mHrLYJNgB57VNPCYhTQRTMDbP8u65HXji2VbgjmKgmqF7YmxTE58RuxWWPbAQtLo3E6r8GJ',
      slot: 453146603,
      blockTime: 1791087542,
      time: '2026-10-04T04:19:02.000Z',
      programId: null,
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.001508840,
      tokenDelta: 0,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'ATA_CLOSE',
      evidenceSource: 'chain-summary.json'
    }
  ];
  fs.writeFileSync(path.join(incidentDir, 'transactions.json'), JSON.stringify(transactions, null, 2), 'utf8');

  const expected = {
    incidentId: 'MR_BEAST',
    taxonomy: ['PRICE_GAP'],
    capitalSwapSol: 0.022731387,
    partialTaken: true,
    partialProceedsSol: 0.015402873,
    finalProceedsSol: 0.001655182,
    netLiquidSol: -0.005698573,
    netReturnPct: -25.0692,
    boughtTokensAtomic: 5506284374,
    partialTokensAtomic: 2753142187,
    finalTokensAtomic: 2753142187,
    peakObservedPnlPct: 39.54,
    firstDeterioratedPnlPct: -85.48,
    poolDropReservePreSol: 302.822274317,
    poolDropReservePostSol: 86.084900580,
    poolDropPct: -71.5725,
    poolCrashTxSignature: '59U3QJFGEAEyzLUGDKeEAcd2ryJEZv9hcwQV9DSk8WySXiUKqKZzAcgsSbSyBRqx973Hm69bYYKpste7sAPd8SdA',
    finalExitTxSignature: 'syypYLfEjBmNcQjcBQjfE6Gt3oDw9NBtPQJYgPBrz3TSGcCXGiLknyBJnQD9Qtoit2C8uQohVeiStDgnWuP9yQJ',
    fillVsSignalQuotePct: 0.3062,
    isPreQuoteCollapse: true,
    isExecutionSlippage: false,
    firstBadObservationAlreadyDeteriorated: true,
    partialOccurredBeforeCrash: true,
    finalFillConfirmed: true
  };
  fs.writeFileSync(path.join(incidentDir, 'expected.json'), JSON.stringify(expected, null, 2), 'utf8');

  const sourceFiles = [
    { file: 'beast-path.jsonl', bytes: 41410, sha256: sha256File(path.join(auditDir, 'beast-path.jsonl')), recordCount: 152 },
    { file: 'beast-crash.jsonl', bytes: 43359, sha256: sha256File(path.join(auditDir, 'beast-crash.jsonl')), recordCount: 174 },
    { file: 'beast-entry.jsonl', bytes: 50356, sha256: sha256File(path.join(auditDir, 'beast-entry.jsonl')), recordCount: 213 },
    { file: 'chain-summary.json', bytes: 21992, sha256: sha256File(path.join(auditDir, 'chain-summary.json')), recordCount: 33 },
    { file: 'pool-crash-transactions.json', bytes: 1290495, sha256: sha256File(path.join(auditDir, 'pool-crash-transactions.json')), recordCount: 2 },
    { file: 'database.json', bytes: 31326, sha256: sha256File(path.join(auditDir, 'database.json')), recordCount: 12 }
  ];

  const manifest = {
    incidentId: 'MR_BEAST',
    tokenSymbol: 'Mr Beast',
    mint: '8nzyZHNFhbpZrf6VpvJPenbc6WrhW6isidrbKAgTMyJ1',
    poolId: 'E3KkCcPjdBd7Qf5WqaKUuwZytyNXvUt7MinCZExdC7Yy',
    sourceFiles: sourceFiles,
    sourceSha256: sha256Buf(Buffer.from(JSON.stringify(sourceFiles))),
    sourceRecordCount: 152,
    auditVersion: '2026-10-04',
    firstTimestamp: '2026-10-04T04:15:09.000Z',
    lastTimestamp: '2026-10-04T04:19:03.608Z',
    knownDeploymentSha: '7904d9c',
    dataCompleteness: 'HIGH_PAGINATED_SERIES',
    knownLimitations: [
      'Sub-millisecond internal latency not captured in legacy logs',
      'Monotonic offsets and positionVersion null in legacy system',
      'Dex liquidity numbers reflect third-party aggregation delay'
    ]
  };
  fs.writeFileSync(path.join(incidentDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

// -------------------------------------------------------------
// 4. Build SUPERPIG
// -------------------------------------------------------------
function buildSuperpig() {
  const incidentDir = path.join(outBase, 'superpig');
  ensureDir(incidentDir);

  const pigLines = fs.readFileSync(path.join(auditDir, 'pig-crash.jsonl'), 'utf8').trim().split('\n').filter(Boolean);

  const observations = [];
  pigLines.forEach(l => {
    const o = JSON.parse(l);
    const wallMs = Date.parse(o.timestamp);
    const msg = o.message;

    // We only create an observation if it is a monitor/sensor/quote/decision/simulation event
    const isObs = msg.includes('SNIPER ATIVO') ||
                  msg.includes('ExitEngine') ||
                  msg.includes('ExitSensor') ||
                  msg.includes('PRICE_DIVERGENCE') ||
                  msg.includes('EXIT CONFIRMADO') ||
                  msg.includes('SIMULAÇÃO PRÉ-VOO BARRADA') ||
                  msg.includes('CONFIRMATION_TIMEOUT') ||
                  msg.includes('TENTATIVA 2 SUCESSO') ||
                  msg.includes('ENTRY:Reconciliação');

    if (!isObs) return;

    const pnlMatch = msg.match(/PnL:\s*([+-]?[\d.]+)%/);
    const peakMatch = msg.match(/Pico:\s*([+-]?[\d.]+)%/);
    const valMatch = msg.match(/Valor:\s*([\d.]+)\s*SOL/);

    let decision = 'HOLD';
    let reason = null;

    if (msg.includes('EXIT CONFIRMADO') || msg.includes('STOP LOSS DISPARADO')) {
      decision = 'STOP_LOSS';
      reason = 'STOP_LOSS';
    } else if (msg.includes('SIMULAÇÃO PRÉ-VOO BARRADA')) {
      decision = 'SIMULATION_REJECTED';
      reason = 'Custom:6001';
    } else if (msg.includes('CONFIRMATION_TIMEOUT')) {
      decision = 'CONFIRMATION_TIMEOUT';
      reason = 'CONFIRMATION_TIMEOUT';
    } else if (msg.includes('TENTATIVA 2 SUCESSO')) {
      decision = 'EXIT_SUCCESS_RETRY';
      reason = 'TENTATIVA 2 SUCESSO';
    }

    observations.push({
      timestampWallMs: wallMs,
      monotonicOffsetMs: null,
      slot: null,
      source: msg.includes('SNIPER ATIVO') ? 'SNIPER_MONITOR' : 'POSITION_EXIT_ENGINE',
      mint: 'tHj1JQKxCV2orW48CA5Nge6MYBJJ73XuJU2pwBapump',
      poolId: null,
      tokenAmountAtomic: '120790429663',
      jupiterExecutableValueSol: valMatch ? parseFloat(valMatch[1]) : null,
      observablePrice: null,
      reserveBase: null,
      reserveQuote: null,
      liquiditySol: null,
      positionVersion: null,
      partialTaken: false,
      pnlPct: pnlMatch ? parseFloat(pnlMatch[1]) : null,
      peakPct: peakMatch ? parseFloat(peakMatch[1]) : null,
      decision: decision,
      reason: reason
    });
  });

  const obsJsonl = observations.map(o => JSON.stringify(o)).join('\n') + '\n';
  verifyNoSecrets(obsJsonl, 'superpig/observations.jsonl');
  fs.writeFileSync(path.join(incidentDir, 'observations.jsonl'), obsJsonl, 'utf8');

  const transactions = [
    {
      signature: 'JxgrAAHwEqBbfpaXYD1T6cVYW97Fk6qgHGLX2Dbdh13HVo19egPNxq9QneBefEuSbLsmeD9GgyMSr6vvUZUq8Rq',
      slot: 452799982,
      blockTime: 1791004504,
      time: '2026-10-03T02:35:04.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: -0.021524991,
      tokenDelta: 120790429663,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'ENTRY_BUY',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '3bhQ9DBSfPYGf3phH4JPzVFe2xBGMQXfpYgaYP8hML5KNme6i2WKaCKbemcjC8ZZhuXqw8u7BLTiG4mjRwVkNVTu',
      slot: 452800149,
      blockTime: 1791004549,
      time: '2026-10-03T02:35:49.000Z',
      programId: 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4',
      instructionIndex: 3,
      innerInstructionIndex: null,
      walletDelta: 0.003061748,
      tokenDelta: -120790429663,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'FINAL_SELL',
      evidenceSource: 'chain-summary.json'
    },
    {
      signature: '2EnfUmNso7QuKFgFfRciKREr8c5zscX4LyWteezFFa3YPiCVy8xRXPQqpBjBQNgvMct7ptvj53mJLKBvDhGUvZmr',
      slot: 452800152,
      blockTime: 1791004549,
      time: '2026-10-03T02:35:49.000Z',
      programId: null,
      instructionIndex: null,
      innerInstructionIndex: null,
      walletDelta: 0.001508840,
      tokenDelta: 0,
      reserveBefore: null,
      reserveAfter: null,
      transactionType: 'ATA_CLOSE',
      evidenceSource: 'chain-summary.json'
    }
  ];
  fs.writeFileSync(path.join(incidentDir, 'transactions.json'), JSON.stringify(transactions, null, 2), 'utf8');

  const expected = {
    incidentId: 'SUPERPIG',
    taxonomy: [
      'EXECUTION_FAILURE',
      'ACCOUNTING_FAILURE',
      'EXECUTION_DELAY',
      'INSUFFICIENT_DEPTH'
    ],
    capitalSwapSol: 0.02,
    partialTaken: false,
    partialProceedsSol: 0.0,
    finalProceedsSol: 0.003183856,
    netLiquidSol: -0.016954403,
    netReturnPct: -84.7720,
    boughtTokensAtomic: 120790429663,
    finalTokensAtomic: 120790429663,
    firstObservationAlreadyNegative: true,
    firstObservationPnlPct: -15.96,
    simulationsRejectedCustomCode: 6001,
    simulationRejectedCount: 3,
    confirmationTimeoutOccurred: true,
    databaseRecordedExitSol: 0.010301,
    databaseRecordedPnlPct: -48.49,
    actualOnChainProceedsSol: 0.003183856,
    actualOnChainNetPnlPct: -84.7720,
    accountingDivergenceSol: 0.007117144,
    accountingDivergencePctPoints: 36.282,
    finalExitTxSignature: '3bhQ9DBSfPYGf3phH4JPzVFe2xBGMQXfpYgaYP8hML5KNme6i2WKaCKbemcjC8ZZhuXqw8u7BLTiG4mjRwVkNVTu'
  };
  fs.writeFileSync(path.join(incidentDir, 'expected.json'), JSON.stringify(expected, null, 2), 'utf8');

  const sourceFiles = [
    { file: 'pig-crash.jsonl', bytes: 36759, sha256: sha256File(path.join(auditDir, 'pig-crash.jsonl')), recordCount: 154 },
    { file: 'chain-summary.json', bytes: 21992, sha256: sha256File(path.join(auditDir, 'chain-summary.json')), recordCount: 33 },
    { file: 'true-errors.jsonl', bytes: 1109, sha256: sha256File(path.join(auditDir, 'true-errors.jsonl')), recordCount: 4 },
    { file: 'database.json', bytes: 31326, sha256: sha256File(path.join(auditDir, 'database.json')), recordCount: 12 }
  ];

  const manifest = {
    incidentId: 'SUPERPIG',
    tokenSymbol: 'SUPERPIG',
    mint: 'tHj1JQKxCV2orW48CA5Nge6MYBJJ73XuJU2pwBapump',
    poolId: null,
    sourceFiles: sourceFiles,
    sourceSha256: sha256Buf(Buffer.from(JSON.stringify(sourceFiles))),
    sourceRecordCount: 154,
    auditVersion: '2026-10-04',
    firstTimestamp: '2026-10-03T02:35:04.000Z',
    lastTimestamp: '2026-10-03T02:35:52.876Z',
    knownDeploymentSha: '7904d9c',
    dataCompleteness: 'CRASH_SERIES_COMPLETE',
    knownLimitations: [
      'Sub-millisecond internal latency not captured in legacy logs',
      'Monotonic offsets and positionVersion null in legacy system',
      'OutAmount of last signed order not captured in legacy logs',
      'Database trade_outcomes table recorded quote instead of on-chain fill'
    ]
  };
  fs.writeFileSync(path.join(incidentDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

// -------------------------------------------------------------
// Run Generator & Report Sizing
// -------------------------------------------------------------
console.log('Generating fixtures...');
buildTesla();
buildSSI();
buildMrBeast();
buildSuperpig();
console.log('Fixtures generated successfully.');

let totalBytes = 0;
let largestFile = { name: '', size: 0 };
let totalRecords = 0;

['tesla', 'ssi', 'mr-beast', 'superpig'].forEach(inc => {
  const dir = path.join(outBase, inc);
  const files = fs.readdirSync(dir);
  console.log(`\nIncident: ${inc}`);
  files.forEach(f => {
    const p = path.join(dir, f);
    const size = fs.statSync(p).size;
    totalBytes += size;
    if (size > largestFile.size) {
      largestFile = { name: `${inc}/${f}`, size: size };
    }
    let records = '-';
    if (f.endsWith('.jsonl')) {
      records = fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length;
      totalRecords += records;
    } else if (f.endsWith('.json')) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (Array.isArray(data)) records = data.length;
    }
    console.log(`  - ${f.padEnd(20)}: ${(size / 1024).toFixed(2).padStart(8)} KB (records: ${records})`);
  });
});

console.log('\n=== FIXTURE SIZING SUMMARY ===');
console.log(`Total fixtures size: ${(totalBytes / 1024).toFixed(2)} KB (${(totalBytes / (1024 * 1024)).toFixed(3)} MB)`);
console.log(`Largest file: ${largestFile.name} (${(largestFile.size / 1024).toFixed(2)} KB)`);
console.log(`Total observation records: ${totalRecords}`);
