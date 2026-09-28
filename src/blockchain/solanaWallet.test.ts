import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Keypair } from '@solana/web3.js';
import { SolanaWalletService } from './solanaWallet.js';

describe('SolanaWalletService - Blindagem e Custódia Segura', () => {
  const dummyKeypair = Keypair.generate();
  const dummySecretKeyString = JSON.stringify(Array.from(dummyKeypair.secretKey));
  const dummyPublicKey = dummyKeypair.publicKey.toBase58();

  it('deve inicializar com chave publica correta e nunca expor a chave privada', () => {
    const wallet = new SolanaWalletService({
      secretKeyRaw: dummySecretKeyString,
      rpcUrl: 'https://api.mainnet-beta.solana.com'
    });

    assert.strictEqual(wallet.getPublicKey(), dummyPublicKey);
    // Garante que o dump/JSON do objeto de carteira não contenha a chave privada em texto claro
    const jsonStr = JSON.stringify(wallet);
    assert.strictEqual(jsonStr.includes(dummySecretKeyString), false);
  });

  it('deve validar teto maximo de risco por trade em 10% do saldo total', () => {
    const wallet = new SolanaWalletService({
      secretKeyRaw: dummySecretKeyString,
      rpcUrl: 'https://api.mainnet-beta.solana.com'
    });

    const totalBalance = 1.0; // 1.0 SOL

    // 0.05 SOL = 5% do saldo -> Permitido
    const check5Percent = wallet.validateTradeAllocation(0.05, totalBalance);
    assert.strictEqual(check5Percent.allowed, true);

    // 0.10 SOL = 10% do saldo -> Permitido (limite exato)
    const check10Percent = wallet.validateTradeAllocation(0.10, totalBalance);
    assert.strictEqual(check10Percent.allowed, true);

    // 0.11 SOL = 11% do saldo -> Bloqueado constitucionalmente
    const check11Percent = wallet.validateTradeAllocation(0.11, totalBalance);
    assert.strictEqual(check11Percent.allowed, false);
    assert.match(check11Percent.reason || '', /Teto de risco excedido/);
  });

  it('deve rejeitar trades se o saldo for insuficiente para cobrir o gas de rede', () => {
    const wallet = new SolanaWalletService({
      secretKeyRaw: dummySecretKeyString,
      rpcUrl: 'https://api.mainnet-beta.solana.com'
    });

    // Saldo residual menor que a reserva de gas (0.005 SOL)
    const checkGas = wallet.validateTradeAllocation(0.0005, 0.003);
    assert.strictEqual(checkGas.allowed, false);
    assert.match(checkGas.reason || '', /Reserva de gas insuficiente/);
  });

  it('deve executar sweepEmptyTokenAccounts sem erro mesmo em ambiente sem contas ativas', async () => {
    const wallet = new SolanaWalletService({
      secretKeyRaw: dummySecretKeyString,
      rpcUrl: 'https://api.mainnet-beta.solana.com'
    });

    const sweepResult = await wallet.sweepEmptyTokenAccounts();
    assert.ok(typeof sweepResult.closedCount === 'number');
    assert.ok(typeof sweepResult.reclaimedSolEst === 'number');
    assert.ok(Array.isArray(sweepResult.errors));
  });
});

