import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeTelemetry,
  sanitizeUrl,
  safeJsonStringify,
  isMnemonic,
  isLikelyPublicIdentifier
} from '../../src/telemetry/redaction';

test('Redaction: deve mascarar chave privada em formato array de 64 bytes', () => {
  const dummyKey = new Array(64).fill(7);
  const payload = {
    wallet: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a',
    keypairBytes: dummyKey,
    note: 'test key'
  };

  const sanitized = sanitizeTelemetry(payload);
  assert.equal(sanitized.keypairBytes, '[REDACTED_BYTE_KEY]');
  assert.equal(sanitized.wallet, '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a');
});

test('Redaction: deve mascarar campos nomeados como privateKey / secretKey / seed', () => {
  const payload = {
    privateKey: 'superSecretPrivateKeyBase58StringHere',
    secret_key: 'anotherSecretKey',
    seed: 'seedStringVal',
    token: 'jwt.token.secret'
  };

  const sanitized = sanitizeTelemetry(payload);
  assert.equal(sanitized.privateKey, '[REDACTED_SECRET]');
  assert.equal(sanitized.secret_key, '[REDACTED_SECRET]');
  assert.equal(sanitized.seed, '[REDACTED_SECRET]');
  assert.equal(sanitized.token, '[REDACTED_SECRET]');
});

test('Redaction: deve detectar e mascarar seed/mnemonic de 12 e 24 palavras', () => {
  const mnemonic12 = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const mnemonic24 = 'legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title';

  assert.equal(isMnemonic(mnemonic12), true);
  assert.equal(isMnemonic(mnemonic24), true);
  assert.equal(isMnemonic('short phrase of four words'), false);

  const payload = {
    phrase12: mnemonic12,
    phrase24: mnemonic24
  };

  const sanitized = sanitizeTelemetry(payload);
  assert.equal(sanitized.phrase12, '[REDACTED_MNEMONIC]');
  assert.equal(sanitized.phrase24, '[REDACTED_MNEMONIC]');
});

test('Redaction: deve mascarar API keys em campos apiKey / api_key / jup_api_key', () => {
  const payload = {
    apiKey: 'jup_api_secret_key_12345',
    api_key: 'helius_secret_67890',
    jup_api_key: 'secret_jupiter_key'
  };

  const sanitized = sanitizeTelemetry(payload);
  assert.equal(sanitized.apiKey, '[REDACTED_SECRET]');
  assert.equal(sanitized.api_key, '[REDACTED_SECRET]');
  assert.equal(sanitized.jup_api_key, '[REDACTED_SECRET]');
});

test('Redaction: deve mascarar header Authorization (Bearer e Basic)', () => {
  const payload = {
    headers: {
      Authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy',
      other: 'application/json'
    },
    rawAuth: 'Basic dXNlcjpwYXNzd29yZA=='
  };

  const sanitized = sanitizeTelemetry(payload);
  assert.equal(sanitized.headers.Authorization, '[REDACTED_SECRET]');
  assert.equal(sanitized.headers.other, 'application/json');
  assert.equal(sanitized.rawAuth, '[REDACTED_AUTH]');
});

test('Redaction: deve sanitizar tokens e api-keys em query params de URLs', () => {
  const url1 = 'https://mainnet.helius-rpc.com/?api-key=abcdef-secret-12345';
  const url2 = 'https://rpc.quicknode.pro/v1/?token=quicknode-token-xyz&other=1';

  const sanitizedUrl1 = sanitizeUrl(url1);
  const sanitizedUrl2 = sanitizeUrl(url2);

  assert.equal(sanitizedUrl1.includes('abcdef-secret-12345'), false);
  assert.equal(sanitizedUrl1.includes('[REDACTED]'), true);
  assert.equal(sanitizedUrl2.includes('quicknode-token-xyz'), false);
  assert.equal(sanitizedUrl2.includes('[REDACTED]'), true);

  const payload = { rpcEndpoint: url1 };
  const sanitizedPayload = sanitizeTelemetry(payload);
  assert.equal(sanitizedPayload.rpcEndpoint.includes('abcdef-secret-12345'), false);
});

test('Redaction: deve mascarar payload binário swapTransaction', () => {
  const payload = {
    requestId: 'req_12345',
    swapTransaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAED...'
  };

  const sanitized = sanitizeTelemetry(payload);
  assert.equal(sanitized.requestId, 'req_12345');
  assert.equal(sanitized.swapTransaction, '[REDACTED_TRANSACTION]');
});

test('Redaction: NUNCA deve mascarar inadvertidamente signatures públicas ou mints', () => {
  const testMint = '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a';
  const testSig = '5nwz7eVDSU4MnT3zzmXyP9kg6w1Uo99GDz8qiZtMkcqUebeLgLbXFMtPpgpZtZ36estEnFhS43JyoYGoKp5xHyTN';

  assert.equal(isLikelyPublicIdentifier('mint', testMint), true);
  assert.equal(isLikelyPublicIdentifier('signature', testSig), true);

  const payload = {
    mint: testMint,
    signature: testSig,
    wallet: '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a'
  };

  const sanitized = sanitizeTelemetry(payload);
  assert.equal(sanitized.mint, testMint);
  assert.equal(sanitized.signature, testSig);
  assert.equal(sanitized.wallet, '3A75w27ssueStCEEp6KGxKJ3EtP57P9FxT6YxHmDnt7a');
});

test('Redaction: safeJsonStringify deve serializar BigInt com segurança', () => {
  const payload = {
    amountLamports: 1000000000n,
    details: { fee: 5000n }
  };

  assert.doesNotThrow(() => {
    const jsonStr = safeJsonStringify(payload);
    assert.equal(jsonStr, '{"amountLamports":"1000000000","details":{"fee":"5000"}}');
  });
});
