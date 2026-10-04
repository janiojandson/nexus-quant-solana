import test from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as http from 'http';
import * as https from 'https';
import { HistoricalReplayEngine, LookaheadViolationError } from '../../src/replay/historicalReplayEngine';
import { classifySolanaProgramError } from '../../src/blockchain/solanaWallet';
import { JUPITER_SWAP_PROGRAM_ID } from '../../src/types/telemetry';

const FIXTURES_DIR = path.join(__dirname, '../fixtures/incidents');
const INCIDENTS = ['tesla', 'ssi', 'mr-beast', 'superpig'] as const;

test('Historical Incident Fixtures & Replay Harness - 20 Mandatory Verifications', async (t) => {
  // 1. Manifest existe para todos os 4 incidentes
  await t.test('1. manifest existe para todos os 4 incidentes', () => {
    for (const inc of INCIDENTS) {
      const manifestPath = path.join(FIXTURES_DIR, inc, 'manifest.json');
      assert.ok(fs.existsSync(manifestPath), `Manifest missing for ${inc}`);
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(data.incidentId, `incidentId missing in ${inc}`);
      assert.ok(data.auditVersion, `auditVersion missing in ${inc}`);
      assert.ok(Array.isArray(data.sourceFiles), `sourceFiles missing in ${inc}`);
    }
  });

  // 2. Source hashes presentes
  await t.test('2. source hashes presentes', () => {
    for (const inc of INCIDENTS) {
      const manifestPath = path.join(FIXTURES_DIR, inc, 'manifest.json');
      const data = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      assert.ok(data.sourceSha256 && typeof data.sourceSha256 === 'string', `sourceSha256 missing in ${inc}`);
      assert.strictEqual(data.sourceSha256.length, 64, `sourceSha256 not 64 hex characters in ${inc}`);
      assert.ok(data.sourceFiles.length > 0, `sourceFiles empty in ${inc}`);
      for (const sf of data.sourceFiles) {
        assert.ok(sf.file, `file missing in sourceFile for ${inc}`);
        assert.ok(typeof sf.bytes === 'number' && sf.bytes > 0, `bytes invalid in ${sf.file} for ${inc}`);
        assert.ok(typeof sf.sha256 === 'string' && sf.sha256.length === 64, `sha256 invalid in ${sf.file} for ${inc}`);
        assert.ok(typeof sf.recordCount === 'number' && sf.recordCount > 0, `recordCount invalid in ${sf.file} for ${inc}`);
      }
    }
  });

  // 3. Record counts válidos
  await t.test('3. record counts válidos', () => {
    const expectedCounts: Record<string, { sourceRecordCount: number; normalizedRecordCount: number }> = {
      tesla: { sourceRecordCount: 2807, normalizedRecordCount: 2807 },
      ssi: { sourceRecordCount: 2891, normalizedRecordCount: 2891 },
      'mr-beast': { sourceRecordCount: 152, normalizedRecordCount: 152 },
      superpig: { sourceRecordCount: 154, normalizedRecordCount: 22 }
    };

    for (const inc of INCIDENTS) {
      const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, inc, 'manifest.json'), 'utf8'));
      const obsLines = fs.readFileSync(path.join(FIXTURES_DIR, inc, 'observations.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      const conf = expectedCounts[inc];
      assert.strictEqual(manifest.sourceRecordCount, conf.sourceRecordCount, `sourceRecordCount mismatch in ${inc}`);
      assert.strictEqual(manifest.normalizedRecordCount, conf.normalizedRecordCount, `normalizedRecordCount mismatch in ${inc}`);
      assert.strictEqual(obsLines.length, conf.normalizedRecordCount, `observations line count mismatch in ${inc}`);
    }
  });

  // 4. Timeline ordenável
  await t.test('4. timeline ordenável', () => {
    for (const inc of INCIDENTS) {
      const obsLines = fs.readFileSync(path.join(FIXTURES_DIR, inc, 'observations.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      let prevTs = 0;
      for (let i = 0; i < obsLines.length; i++) {
        const obs = JSON.parse(obsLines[i]);
        assert.ok(
          obs.timestampWallMs >= prevTs,
          `Timeline not sorted in ${inc} at line ${i + 1}: ${obs.timestampWallMs} < ${prevTs}`
        );
        prevTs = obs.timestampWallMs;
      }
    }
  });

  // 5. Nenhum timestamp inventado
  await t.test('5. nenhum timestamp inventado', () => {
    const MIN_VALID_TIMESTAMP = 1_700_000_000_000; // Late 2023+ (actual timestamps are Oct 2026 ~1.79e12)
    for (const inc of INCIDENTS) {
      const obsLines = fs.readFileSync(path.join(FIXTURES_DIR, inc, 'observations.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      for (let i = 0; i < obsLines.length; i++) {
        const obs = JSON.parse(obsLines[i]);
        assert.strictEqual(typeof obs.timestampWallMs, 'number', `timestampWallMs not a number at ${inc}:${i + 1}`);
        assert.ok(!isNaN(obs.timestampWallMs), `timestampWallMs is NaN at ${inc}:${i + 1}`);
        assert.ok(obs.timestampWallMs > MIN_VALID_TIMESTAMP, `timestampWallMs too small (possibly 0) at ${inc}:${i + 1}`);
      }
    }
  });

  // 6. null continua null
  await t.test('6. null continua null', () => {
    for (const inc of INCIDENTS) {
      const obsLines = fs.readFileSync(path.join(FIXTURES_DIR, inc, 'observations.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      for (const line of obsLines) {
        const obs = JSON.parse(line);
        // Rule: Não fabricar slot, reserve, price, positionVersion. Missing must remain strictly null.
        assert.strictEqual(obs.monotonicOffsetMs, null, `monotonicOffsetMs must be null`);
        assert.strictEqual(obs.slot, null, `slot must be null`);
        assert.strictEqual(obs.positionVersion, null, `positionVersion must be null`);
        assert.strictEqual(obs.reserveBase, null, `reserveBase must be null`);
        assert.strictEqual(obs.reserveQuote, null, `reserveQuote must be null`);
      }
    }
  });

  // 7. zero-lookahead
  await t.test('7. zero-lookahead', () => {
    const engine = new HistoricalReplayEngine();
    const data = engine.loadFixture(path.join(FIXTURES_DIR, 'tesla'));

    // Step to the middle observation
    const midIdx = Math.floor(data.observations.length / 2);
    const midObs = data.observations[midIdx];
    const targetHorizon = midObs.timestampWallMs;

    // Run replay up to mid
    engine.runReplay({
      stepHook: (step) => {
        if (step.stepIndex === midIdx) {
          // At step midIdx, visible count must be exactly midIdx + 1
          const visible = engine.getVisibleObservations();
          assert.strictEqual(visible.length, midIdx + 1);
          // And all visible items must have timestamp <= targetHorizon
          for (const item of visible) {
            assert.ok(item.timestampWallMs <= targetHorizon, `Item exceeded horizon: ${item.timestampWallMs} > ${targetHorizon}`);
          }

          // Requesting future observation horizon beyond current must throw LookaheadViolationError
          assert.throws(
            () => engine.getVisibleObservations(targetHorizon + 10_000),
            LookaheadViolationError
          );

          // Asserting no lookahead on future timestamp must throw
          assert.throws(
            () => engine.assertNoLookahead(targetHorizon + 1),
            LookaheadViolationError
          );
        }
      }
    });
  });

  // 8. nenhuma consulta de rede
  await t.test('8. nenhuma consulta de rede', () => {
    let networkCallAttempted = false;

    const originalHttp = http.request;
    const originalHttps = https.request;
    const originalFetch = globalThis.fetch;

    // Monkey-patch to detect any outbound network call
    (http as any).request = () => { networkCallAttempted = true; throw new Error('Network disabled during replay'); };
    (https as any).request = () => { networkCallAttempted = true; throw new Error('Network disabled during replay'); };
    (globalThis as any).fetch = () => { networkCallAttempted = true; throw new Error('Network disabled during replay'); };

    try {
      const engine = new HistoricalReplayEngine();
      for (const inc of INCIDENTS) {
        engine.loadFixture(path.join(FIXTURES_DIR, inc));
        engine.runReplay();
      }
      assert.strictEqual(networkCallAttempted, false, 'Replay engine attempted network calls');
    } finally {
      http.request = originalHttp;
      https.request = originalHttps;
      globalThis.fetch = originalFetch;
    }
  });

  // 9. nenhuma leitura de private key
  await t.test('9. nenhuma leitura de private key', () => {
    const PRIV_PATTERNS = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /xprv[a-zA-Z0-9]{100,}/,
      /"privateKey":/,
      /"secretKey":/
    ];

    for (const inc of INCIDENTS) {
      const incDir = path.join(FIXTURES_DIR, inc);
      const files = fs.readdirSync(incDir);
      for (const f of files) {
        const content = fs.readFileSync(path.join(incDir, f), 'utf8');
        for (const pat of PRIV_PATTERNS) {
          assert.ok(!pat.test(content), `Found forbidden private key pattern in ${inc}/${f}`);
        }
      }
    }
  });

  // 10. nenhuma URL secreta
  await t.test('10. nenhuma URL secreta', () => {
    const SECRET_URL_PATTERNS = [
      /https?:\/\/[^:]+:[^@]+@/,
      /postgresql:\/\/[^:]+:[^@]+@/,
      /[?&](api[-_]?key|token|auth|password)=[^&]+/i
    ];

    for (const inc of INCIDENTS) {
      const incDir = path.join(FIXTURES_DIR, inc);
      const files = fs.readdirSync(incDir);
      for (const f of files) {
        const content = fs.readFileSync(path.join(incDir, f), 'utf8');
        for (const pat of SECRET_URL_PATTERNS) {
          assert.ok(!pat.test(content), `Found secret in URL pattern in ${inc}/${f}`);
        }
      }
    }
  });

  // 11. assinaturas públicas preservadas
  await t.test('11. assinaturas públicas preservadas', () => {
    const verifiedSignatures: Record<string, string[]> = {
      tesla: [
        '39ewp5zPn2Yt2R2XKPcYjeYzfEUaCbaYxrUvjeKAcxDXurNmHkax2NQgt7Tf2ohsGfzPGETVjNZcEyTiJDp1QEb4',
        '2ti4qD2YffXcJnTj5swzvgoNGYd798qQD6gECvP88UfAcacTY53mmWgoH7GzLsaqSveQ3Y6a7BS18ruyv4FX8Hye',
        '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN'
      ],
      ssi: [
        '4Vq6ahBPh8RdnAp84xLEze4igS3jg8bwgYWxVS3Goy2UqY6TenkPDymizNNMQESriFnoXh5HXM3z4bkZds5YqkoT',
        '2UJoZzLXErPHjWLsbBcdhFfbwRB8zRLHHvnmPnR3uqKffUjiENe2eZwUgFjAmxediX6iRW9m641ogYT4V55ihPML',
        '4mMBHLwEBk7fwV3zp7w8CyfCWzff1H9BaDJVWEmAL2TPVsHffAJHMKrNkupErsQL4QZ4keZQULBuMZxY4EBeQNAT'
      ],
      'mr-beast': [
        'nn7biyBdbtjHS7WPUxEC2xEZGKdgnwctJBB84k2z2o683Sqyuy6fi96cBDFfhpnVEf1mHuZJxTbTP1K5wfbgpXZ',
        '59U3QJFGEAEyzLUGDKeEAcd2ryJEZv9hcwQV9DSk8WySXiUKqKZzAcgsSbSyBRqx973Hm69bYYKpste7sAPd8SdA',
        'syypYLfEjBmNcQjcBQjfE6Gt3oDw9NBtPQJYgPBrz3TSGcCXGiLknyBJnQD9Qtoit2C8uQohVeiStDgnWuP9yQJ'
      ],
      superpig: [
        'JxgrAAHwEqBbfpaXYD1T6cVYW97Fk6qgHGLX2Dbdh13HVo19egPNxq9QneBefEuSbLsmeD9GgyMSr6vvUZUq8Rq',
        '3bhQ9DBSfPYGf3phH4JPzVFe2xBGMQXfpYgaYP8hML5KNme6i2WKaCKbemcjC8ZZhuXqw8u7BLTiG4mjRwVkNVTu'
      ]
    };

    for (const [inc, sigs] of Object.entries(verifiedSignatures)) {
      const txs: Array<{ signature: string }> = JSON.parse(
        fs.readFileSync(path.join(FIXTURES_DIR, inc, 'transactions.json'), 'utf8')
      );
      const existingSigs = new Set(txs.map(t => t.signature));
      for (const s of sigs) {
        assert.ok(existingSigs.has(s), `Verified signature ${s} missing in ${inc}/transactions.json`);
      }
    }
  });

  // 12. Tesla facts reproduzíveis
  await t.test('12. Tesla facts reproduzíveis', () => {
    const engine = new HistoricalReplayEngine();
    engine.loadFixture(path.join(FIXTURES_DIR, 'tesla'));
    const metrics = engine.runReplay();
    const exp = engine.fixture.expected;

    assert.strictEqual(exp.incidentId, 'TESLA');
    assert.deepStrictEqual(exp.taxonomy, ['PRICE_GAP']);
    assert.strictEqual(exp.capitalSwapSol, 0.02);
    assert.strictEqual(exp.partialTaken, true);
    assert.strictEqual(exp.partialProceedsSol, 0.013533348);
    assert.strictEqual(exp.finalProceedsSol, 0.000041149);
    assert.strictEqual(exp.netLiquidSol, -0.00645572);
    assert.strictEqual(exp.netReturnPct, -32.2786);
    assert.strictEqual(exp.firstDeterioratedPnlPct, -99.59);
    assert.strictEqual(exp.poolDropPct, -99.773);
    assert.strictEqual(metrics.fillVsSignalQuotePct, 0.0);
    assert.strictEqual(exp.fillVsSignalQuotePct, 0.0);
    assert.strictEqual(metrics.fillValue, 0.000041149);
    assert.strictEqual(metrics.confirmedProceeds, 0.013574497);
  });

  // 13. SSI facts reproduzíveis
  await t.test('13. SSI facts reproduzíveis', () => {
    const engine = new HistoricalReplayEngine();
    engine.loadFixture(path.join(FIXTURES_DIR, 'ssi'));
    const metrics = engine.runReplay();
    const exp = engine.fixture.expected;

    assert.strictEqual(exp.incidentId, 'SSI');
    assert.deepStrictEqual(exp.taxonomy, ['PRICE_GAP']);
    assert.strictEqual(exp.capitalSwapSol, 0.021826256);
    assert.strictEqual(exp.partialTaken, true);
    assert.strictEqual(exp.partialProceedsSol, 0.014854168);
    assert.strictEqual(exp.finalProceedsSol, 0.002137281);
    assert.strictEqual(exp.netLiquidSol, -0.004860143);
    assert.strictEqual(exp.netReturnPct, -22.2674);
    assert.strictEqual(exp.peakObservedPnlPct, 986.98);
    assert.strictEqual(exp.firstDeterioratedPnlPct, -80.46);
    assert.strictEqual(exp.poolDropPct, -88.2412);
    // Fill was 0.2171% better than signal quote
    assert.strictEqual(metrics.fillVsSignalQuotePct, 0.2171);
    assert.strictEqual(metrics.fillValue, 0.002137281);
    assert.strictEqual(metrics.signalExecutableValue, 0.002132652);
  });

  // 14. Mr Beast facts reproduzíveis
  await t.test('14. Mr Beast facts reproduzíveis', () => {
    const engine = new HistoricalReplayEngine();
    engine.loadFixture(path.join(FIXTURES_DIR, 'mr-beast'));
    const metrics = engine.runReplay();
    const exp = engine.fixture.expected;

    assert.strictEqual(exp.incidentId, 'MR_BEAST');
    assert.deepStrictEqual(exp.taxonomy, ['PRICE_GAP']);
    assert.strictEqual(exp.capitalSwapSol, 0.022731387);
    assert.strictEqual(exp.peakObservedPnlPct, 39.54);
    assert.strictEqual(exp.firstDeterioratedPnlPct, -85.48);
    assert.strictEqual(exp.poolDropPct, -71.5725);
    // Fill was 0.3062% better than signal quote (pre-quote collapse, NOT execution slippage)
    assert.strictEqual(metrics.fillVsSignalQuotePct, 0.3062);
    assert.strictEqual(metrics.fillValue, 0.001655182);
    assert.strictEqual(metrics.signalExecutableValue, 0.001650130);
    assert.strictEqual(exp.isPreQuoteCollapse, true);
    assert.strictEqual(exp.isExecutionSlippage, false);
  });

  // 15. SUPERPIG facts reproduzíveis
  await t.test('15. SUPERPIG facts reproduzíveis', () => {
    const engine = new HistoricalReplayEngine();
    engine.loadFixture(path.join(FIXTURES_DIR, 'superpig'));
    const metrics = engine.runReplay();
    const exp = engine.fixture.expected;

    assert.strictEqual(exp.incidentId, 'SUPERPIG');
    assert.ok(exp.taxonomy.includes('EXECUTION_FAILURE'));
    assert.ok(exp.taxonomy.includes('ACCOUNTING_FAILURE'));
    assert.strictEqual(exp.capitalSwapSol, 0.02);
    assert.strictEqual(exp.partialTaken, false);
    assert.strictEqual(exp.firstObservationAlreadyNegative, true);
    assert.strictEqual(exp.firstObservationPnlPct, -15.96);
    assert.strictEqual(exp.simulationsRejectedCustomCode, 6001);
    assert.strictEqual(exp.simulationRejectedCount, 3);
    assert.strictEqual(exp.confirmationTimeoutOccurred, true);
    assert.strictEqual(exp.actualOnChainProceedsSol, 0.003183856);
    assert.strictEqual(exp.actualOnChainNetPnlPct, -84.7720);
    assert.strictEqual(metrics.fillValue, 0.003183856);
  });

  // 16. fillVsSignalQuote não usa MFE como denominador
  await t.test('16. fillVsSignalQuote não usa MFE como denominador', () => {
    const engine = new HistoricalReplayEngine();
    engine.loadFixture(path.join(FIXTURES_DIR, 'mr-beast'));
    const metrics = engine.runReplay();

    const signalValue = 0.001650130;
    const fillValue = 0.001655182;
    const peakValue = 0.015860223; // MFE peak executable value

    const correctFormula = ((fillValue - signalValue) / signalValue) * 100;
    const wrongFormulaWithMfe = ((fillValue - signalValue) / peakValue) * 100;

    assert.ok(Math.abs(Number(metrics.fillVsSignalQuotePct) - correctFormula) < 0.001);
    assert.notStrictEqual(metrics.fillVsSignalQuotePct, wrongFormulaWithMfe);
    assert.ok(
      Math.abs(Number(metrics.fillVsSignalQuotePct) - wrongFormulaWithMfe) > 0.2,
      'fillVsSignalQuotePct erroneously used MFE as denominator'
    );
  });

  // 17. accounting do SUPERPIG preserva divergência histórica
  await t.test('17. accounting do SUPERPIG preserva divergência histórica', () => {
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'superpig', 'expected.json'), 'utf8'));

    assert.strictEqual(expected.databaseRecordedExitSol, 0.010301);
    assert.strictEqual(expected.databaseRecordedPnlPct, -48.49);
    assert.strictEqual(expected.actualOnChainProceedsSol, 0.003183856);
    assert.strictEqual(expected.actualOnChainNetPnlPct, -84.7720);

    const solDivergence = expected.databaseRecordedExitSol - expected.actualOnChainProceedsSol;
    assert.ok(Math.abs(solDivergence - 0.007117144) < 1e-7, 'SOL divergence must match ~0.007117 SOL');

    const pctPointsDivergence = Math.abs(expected.actualOnChainNetPnlPct - expected.databaseRecordedPnlPct);
    assert.ok(Math.abs(pctPointsDivergence - 36.282) < 0.01, 'Percentage points divergence must match ~36.28 pp');
  });

  // 18. erro Jupiter 6014 não aparece como slippage
  await t.test('18. erro Jupiter 6014 não aparece como slippage', () => {
    const classification = classifySolanaProgramError(
      JUPITER_SWAP_PROGRAM_ID,
      6014,
      'Program log: Custom program error: 0x177e'
    );

    assert.strictEqual(classification.classification, 'JUPITER_INCORRECT_TOKEN_PROGRAM_ID');
    assert.notStrictEqual(classification.classification, 'JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED');
    assert.notStrictEqual(classification.classification, 'SLIPPAGE_EXCEEDED');
    assert.strictEqual(classification.classificationSource, 'JUPITER_SWAP_PROGRAM_KNOWN_ERRORS');
    assert.strictEqual(classification.classificationVersion, '2026-10-04');
  });

  // 19. erro Jupiter 6001 só recebe classificação Jupiter quando programId corresponde
  await t.test('19. erro Jupiter 6001 só recebe classificação Jupiter quando programId corresponde', () => {
    // 1. Jupiter Program + 6001 -> JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED
    const jupRes = classifySolanaProgramError(JUPITER_SWAP_PROGRAM_ID, 6001);
    assert.strictEqual(jupRes.classification, 'JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED');
    assert.strictEqual(jupRes.classificationSource, 'JUPITER_SWAP_PROGRAM_KNOWN_ERRORS');

    // 2. Outro Program ID + 6001 -> UNKNOWN
    const otherProgramId = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
    const otherRes = classifySolanaProgramError(otherProgramId, 6001);
    assert.strictEqual(otherRes.classification, 'UNKNOWN');
    assert.strictEqual(otherRes.classificationSource, 'UNKNOWN');

    // 3. Sem Program ID + 6001 -> UNKNOWN
    const nullProgramRes = classifySolanaProgramError(null, 6001);
    assert.strictEqual(nullProgramRes.classification, 'UNKNOWN');
    assert.strictEqual(nullProgramRes.classificationSource, 'UNKNOWN');
  });

  // 20. replay determinístico produz mesmo resultado duas vezes
  await t.test('20. replay determinístico produz mesmo resultado duas vezes', () => {
    const engine = new HistoricalReplayEngine();

    for (const inc of INCIDENTS) {
      engine.loadFixture(path.join(FIXTURES_DIR, inc));
      const run1 = engine.runReplay();

      engine.loadFixture(path.join(FIXTURES_DIR, inc));
      const run2 = engine.runReplay();

      assert.deepStrictEqual(
        run1,
        run2,
        `Replay run1 and run2 produced divergent results for incident ${inc}`
      );
    }
  });

  // 21. Correção 1 - Contagem SUPERPIG derivada diretamente do arquivo vs manifest
  await t.test('21. contagem SUPERPIG derivada diretamente do arquivo vs manifest.normalizedRecordCount', () => {
    const superpigObsPath = path.join(FIXTURES_DIR, 'superpig', 'observations.jsonl');
    const superpigLines = fs.readFileSync(superpigObsPath, 'utf8').trim().split('\n').filter(Boolean);
    const superpigManifest = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'superpig', 'manifest.json'), 'utf8'));

    // Derived directly from the normalized observations file
    assert.strictEqual(superpigLines.length, 22, 'SUPERPIG observations.jsonl must contain exactly 22 lines');
    assert.strictEqual(superpigManifest.normalizedRecordCount, 22, 'SUPERPIG manifest normalizedRecordCount must be 22');
    assert.strictEqual(superpigManifest.sourceRecordCount, 154, 'SUPERPIG manifest sourceRecordCount must be 154');

    // Total derived observations across all 4 incidents must equal exactly 5872
    let totalDerivedObs = 0;
    const perIncidentObs: Record<string, number> = {};
    for (const inc of INCIDENTS) {
      const lines = fs.readFileSync(path.join(FIXTURES_DIR, inc, 'observations.jsonl'), 'utf8').trim().split('\n').filter(Boolean);
      perIncidentObs[inc] = lines.length;
      totalDerivedObs += lines.length;
    }

    assert.strictEqual(perIncidentObs['tesla'], 2807);
    assert.strictEqual(perIncidentObs['ssi'], 2891);
    assert.strictEqual(perIncidentObs['mr-beast'], 152);
    assert.strictEqual(perIncidentObs['superpig'], 22);
    assert.strictEqual(totalDerivedObs, 5872, 'Sum of derived observation lines must equal 5872');
  });

  // 22. Correção 2 - Timing grosseiro (COARSE) e bounds de incerteza de ~1s
  await t.test('22. timing grosseiro (COARSE) com bounds de incerteza de ~1s devido à resolução do blockTime', () => {
    const engine = new HistoricalReplayEngine();

    for (const inc of ['tesla', 'ssi', 'mr-beast']) {
      engine.loadFixture(path.join(FIXTURES_DIR, inc));
      const metrics = engine.runReplay();

      assert.strictEqual(metrics.latencyPrecision, 'COARSE', `Latency precision must be COARSE for ${inc}`);
      assert.strictEqual(metrics.eventTimeResolutionMs, 1000, `eventTimeResolutionMs must be 1000 for ${inc}`);
      assert.strictEqual(metrics.eventTimeSource, 'SOLANA_BLOCK_TIME', `eventTimeSource must be SOLANA_BLOCK_TIME for ${inc}`);
      assert.strictEqual(typeof metrics.approxEventToObservationMs, 'number', `approxEventToObservationMs missing in ${inc}`);
      assert.strictEqual(typeof metrics.eventToObservationLowerBoundMs, 'number', `eventToObservationLowerBoundMs missing in ${inc}`);
      assert.strictEqual(typeof metrics.eventToObservationUpperBoundMs, 'number', `eventToObservationUpperBoundMs missing in ${inc}`);

      const lower = metrics.eventToObservationLowerBoundMs as number;
      const upper = metrics.eventToObservationUpperBoundMs as number;
      assert.ok(upper >= lower, `upperBound (${upper}) must be >= lowerBound (${lower}) in ${inc}`);
      assert.ok(upper - lower <= 1000, `Uncertainty interval must be <= 1000ms (~1s) in ${inc}`);

      // Semantic rule: coarse latency cannot be used to claim subsecond advantage like 300ms against ~1s reference
      assert.notStrictEqual(metrics.latencyPrecision, 'FINE');
    }
  });

  // 23. Correção 3 - PRICE_GAP confirmado NÃO prova ausência de DETECTION_FAILURE
  await t.test('23. PRICE_GAP confirmado NÃO prova ausência de DETECTION_FAILURE', () => {
    for (const inc of ['tesla', 'ssi', 'mr-beast']) {
      const exp = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, inc, 'expected.json'), 'utf8'));

      // PRICE_GAP is confirmed by pool collapse preceding quote
      assert.strictEqual(exp.priceGapStatus, 'CONFIRMED', `PRICE_GAP must be CONFIRMED in ${inc}`);
      // DETECTION_FAILURE is NOT_DEMONSTRATED (historical monitor reacted immediately, but earlier on-chain detection is unknown)
      assert.strictEqual(exp.detectionFailureStatus, 'NOT_DEMONSTRATED', `DETECTION_FAILURE must be NOT_DEMONSTRATED in ${inc}`);
      assert.notStrictEqual(exp.detectionFailureStatus, false, `Must NOT record DETECTION_FAILURE = false in ${inc}`);

      // Segregation between current path performance and alternative future sensor
      assert.strictEqual(exp.currentPathMissedAvailableData, false, `currentPathMissedAvailableData must be false in ${inc}`);
      assert.strictEqual(exp.alternativeSensorCouldObserveEarlier, 'UNKNOWN', `alternativeSensorCouldObserveEarlier must be UNKNOWN in ${inc}`);
    }
  });

  // 24. Correção 4 - Restrições de execução atômica (vantagem de detecção permitida, pre-crash fill proibido)
  await t.test('24. restrições de execução atômica proíbem pre-crash fill retroativo', () => {
    for (const inc of INCIDENTS) {
      const exp = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, inc, 'expected.json'), 'utf8'));
      const constraints = exp.atomicExecutionConstraints;

      assert.ok(constraints, `atomicExecutionConstraints missing in ${inc}`);
      assert.strictEqual(constraints.allowsPreCrashFill, false, `allowsPreCrashFill must be FALSE in ${inc}`);
      assert.strictEqual(constraints.atomicSwapConfirmedBeforeExit, true, `atomicSwapConfirmedBeforeExit must be TRUE in ${inc}`);
      assert.strictEqual(constraints.detectionAdvantageMeasurable, true, `detectionAdvantageMeasurable must be TRUE in ${inc}`);
      assert.strictEqual(constraints.retroactiveExecutionAllowed, false, `retroactiveExecutionAllowed must be FALSE in ${inc}`);
    }
  });

  // 25. Correção 5 - Hash das fixtures normalizadas contra fixtures.lock.json
  await t.test('25. SHA-256 das fixtures normalizadas confere exatamente com fixtures.lock.json', () => {
    const lockPath = path.join(FIXTURES_DIR, 'fixtures.lock.json');
    assert.ok(fs.existsSync(lockPath), 'fixtures.lock.json missing');

    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.strictEqual(lock.version, '2026-10-04');
    assert.ok(lock.fixtures, 'fixtures object missing in lock file');

    for (const inc of INCIDENTS) {
      const dir = path.join(FIXTURES_DIR, inc);
      const incLock = lock.fixtures[inc];
      assert.ok(incLock, `Lock missing fixture entry for ${inc}`);

      const manifestSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'manifest.json'))).digest('hex');
      const obsSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'observations.jsonl'))).digest('hex');
      const txSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'transactions.json'))).digest('hex');
      const expSha = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, 'expected.json'))).digest('hex');

      assert.strictEqual(manifestSha, incLock.manifestSha256, `manifest.json hash mismatch in ${inc}`);
      assert.strictEqual(obsSha, incLock.observationsSha256, `observations.jsonl hash mismatch in ${inc}`);
      assert.strictEqual(txSha, incLock.transactionsSha256, `transactions.json hash mismatch in ${inc}`);
      assert.strictEqual(expSha, incLock.expectedSha256, `expected.json hash mismatch in ${inc}`);
    }

    // Asserts lock file does NOT contain recursive self-hash
    assert.strictEqual((lock as any).lockSha256, undefined, 'Lock must not include recursive self-hash');
  });

  // 26. Correção 6 - Build determinístico sem timestamps voláteis nos arquivos normalizados
  await t.test('26. build determinístico sem timestamps voláteis (Date.now()) nos arquivos normalizados', () => {
    for (const inc of INCIDENTS) {
      const manifestStr = fs.readFileSync(path.join(FIXTURES_DIR, inc, 'manifest.json'), 'utf8');
      const expectedStr = fs.readFileSync(path.join(FIXTURES_DIR, inc, 'expected.json'), 'utf8');

      // Ensure no volatile generatedAt timestamps exist
      assert.ok(!manifestStr.includes('"generatedAt"'), `manifest in ${inc} contains volatile generatedAt`);
      assert.ok(!expectedStr.includes('"generatedAt"'), `expected in ${inc} contains volatile generatedAt`);

      const manifest = JSON.parse(manifestStr);
      assert.strictEqual(manifest.auditVersion, '2026-10-04');
    }
  });

  // 27. Correção 7 - Erro SUPERPIG 6001 classificado como UNKNOWN na ausência de programId comprovado
  await t.test('27. erro SUPERPIG 6001 classificado como UNKNOWN na ausência de programId comprovado', () => {
    const superpigExp = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'superpig', 'expected.json'), 'utf8'));

    assert.strictEqual(superpigExp.simulationsRejectedCustomCode, 6001);
    assert.strictEqual(superpigExp.simulationProgramIdProven, false);
    assert.strictEqual(superpigExp.simulationClassification, 'UNKNOWN');

    // Classification requires both programId AND customCode
    const noProgramRes = classifySolanaProgramError(null, 6001);
    assert.strictEqual(noProgramRes.classification, 'UNKNOWN');

    const unprovenProgramRes = classifySolanaProgramError('UnknownProgram1111111111111111111111111111', 6001);
    assert.strictEqual(unprovenProgramRes.classification, 'UNKNOWN');

    // Only when proven Jupiter swap program is passed does it resolve to JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED
    const provenJupRes = classifySolanaProgramError(JUPITER_SWAP_PROGRAM_ID, 6001);
    assert.strictEqual(provenJupRes.classification, 'JUPITER_SLIPPAGE_TOLERANCE_EXCEEDED');
  });
});
