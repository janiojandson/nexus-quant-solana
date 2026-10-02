import test from 'node:test';
import assert from 'node:assert';
import { TokenClassifier, TokenCategory, AntiSpamMemory } from './tokenClassifier.js';

test('TokenClassifier: deve barrar SOL e Wrapped SOL como BASE_INFRASTRUCTURE', () => {
  const resultSol = TokenClassifier.classify(
    'So11111111111111111111111111111111111111112',
    'SOL',
    2000000000
  );
  assert.strictEqual(resultSol.category, TokenCategory.BASE_INFRASTRUCTURE);
  assert.strictEqual(resultSol.isEligibleForMemeScan, false);

  const resultFakeSol = TokenClassifier.classify(
    '97owM7j5K2ciCKjh1Efi8ix8Et9Tp7sjgnmLM2CHMamN',
    'SOL',
    2000000
  );
  assert.strictEqual(resultFakeSol.isEligibleForMemeScan, false);
});

test('TokenClassifier: deve classificar memecoins em subgrupos por liquidez', () => {
  const micro = TokenClassifier.classify('MintMicro111', 'PEPE', 25000);
  assert.strictEqual(micro.category, TokenCategory.MICRO_CAP_MEME);
  assert.strictEqual(micro.isEligibleForMemeScan, true);

  const mid = TokenClassifier.classify('MintMid111', 'WIF', 150000);
  assert.strictEqual(mid.category, TokenCategory.MID_CAP_MEME);
  assert.strictEqual(mid.isEligibleForMemeScan, true);

  const established = TokenClassifier.classify('MintEst111', 'BONK', 1200000);
  assert.strictEqual(established.category, TokenCategory.ESTABLISHED_TOKEN);
  assert.strictEqual(established.isEligibleForMemeScan, true);
});

test('AntiSpamMemory: deve evitar reprocessamento repetitivo de tokens vetados', () => {
  const memory = new AntiSpamMemory(60);
  const mint = 'BadTokenMint123';

  // Primeira vez: não deve pular
  assert.strictEqual(memory.shouldSkip(mint).skip, false);

  // Registra veto
  memory.recordVeto(mint, 'LP desbloqueada');

  // Segunda vez: deve pular sem fazer perguntas repetitivas
  const check = memory.shouldSkip(mint);
  assert.strictEqual(check.skip, true);
  assert.match(check.reason || '', /quarentena/);
});

test('AntiSpamMemory: deve aplicar TTL curto de 5 minutos para descarte técnico permitindo reavaliação', () => {
  const memory = new AntiSpamMemory(60);
  const mint = 'YoungPoolMint789';

  // Registra descarte técnico de 5 minutos
  memory.recordTechnicalDiscard(mint, 'Idade < 20m', 5);

  // Logo em seguida deve pular
  assert.strictEqual(memory.shouldSkip(mint).skip, true);

  // Simula expiração: se customTtlMs for passado negativo (-1ms)
  memory.recordTechnicalDiscard(mint, 'Idade atingiu 20m agora', -0.01);
  assert.strictEqual(memory.shouldSkip(mint).skip, false);
});


test('AntiSpamMemory: veto posterior deve limpar aprovação pendente', () => {
  const memory = new AntiSpamMemory(60);
  const mint = 'ApprovedThenVetoedMint';

  memory.recordApproval(mint, 91);
  assert.match(memory.shouldSkip(mint).reason || '', /aprovado recentemente/i);

  memory.recordVeto(mint, 'Momentum não confirmado', -1);
  assert.strictEqual(
    memory.shouldSkip(mint).skip,
    false,
    'após expirar o veto curto, uma aprovação antiga não pode continuar bloqueando o mint'
  );
});
