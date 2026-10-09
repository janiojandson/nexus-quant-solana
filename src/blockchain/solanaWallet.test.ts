import { describe, it } from 'node:test';
import assert from 'node:assert';
import { Keypair } from '@solana/web3.js';
import { SolanaWalletService } from './solanaWallet.js';

const LIVE_ENV = { SHADOW_MODE: 'false', DRY_RUN_MODE: 'false' };

it('shadow wallet never reads a hostile secret getter and cannot expose a signer', async () => {
  const owner = Keypair.generate().publicKey.toBase58();
  const config = {
    connection: {} as any,
    publicKey: owner,
    executionEnv: { SHADOW_MODE: 'true', DRY_RUN_MODE: 'false' },
    get secretKeyRaw(): string { throw new Error('secret was read'); }
  };
  const wallet = new SolanaWalletService(config);
  assert.equal(wallet.getPublicKey(), owner);
  assert.throws(() => wallet.getKeypair(), /shadow|signer/i);
  (wallet as any).connection = { getAccountInfo: () => { throw new Error('RPC was called'); } };
  assert.deepEqual(await wallet.closeTokenAccount(owner), { txSignature: null, success: false });
  assert.deepEqual(await wallet.sweepEmptyTokenAccounts(), { closedCount: 0, reclaimedSolEst: 0, errors: [] });
});

it('a generated key supplied in shadow cannot close accounts', async () => {
  const signer = Keypair.generate();
  const wallet = new SolanaWalletService({connection:{} as any,
    publicKey: signer.publicKey.toBase58(),
    secretKeyRaw: JSON.stringify(Array.from(signer.secretKey)),
    executionEnv: { SHADOW_MODE: 'false', DRY_RUN_MODE: 'true' }
  });
  (wallet as any).connection = { getAccountInfo: () => { throw new Error('RPC was called'); } };
  assert.deepEqual(await wallet.closeTokenAccount(signer.publicKey.toBase58()), { txSignature: null, success: false });
});

describe('SolanaWalletService - Blindagem e CustÃ³dia Segura', () => {
  const dummyKeypair = Keypair.generate();
  const dummySecretKeyString = JSON.stringify(Array.from(dummyKeypair.secretKey));
  const dummyPublicKey = dummyKeypair.publicKey.toBase58();

  it('deve inicializar com chave publica correta e nunca expor a chave privada', () => {
    const wallet = new SolanaWalletService({connection:{} as any,
      secretKeyRaw: dummySecretKeyString,
      executionEnv: LIVE_ENV,
      rpcUrl: 'https://api.mainnet-beta.solana.com'
    });

    assert.strictEqual(wallet.getPublicKey(), dummyPublicKey);
    // Garante que o dump/JSON do objeto de carteira nÃ£o contenha a chave privada em texto claro
    const jsonStr = JSON.stringify(wallet);
    assert.strictEqual(jsonStr.includes(dummySecretKeyString), false);
  });

  it('deve abortar inicializa??o quando a chave estiver ausente ou inv?lida', () => {
    assert.throws(() => new SolanaWalletService({connection:{} as any, secretKeyRaw: '[]', executionEnv: LIVE_ENV }), /Chave privada Solana ausente/);
    assert.throws(() => new SolanaWalletService({connection:{} as any, secretKeyRaw: 'not-a-valid-key', executionEnv: LIVE_ENV }), /Chave privada Solana/);
  });

  it('deve validar teto maximo de risco por trade em 10% do saldo total', () => {
    const wallet = new SolanaWalletService({connection:{} as any,
      secretKeyRaw: dummySecretKeyString,
      executionEnv: LIVE_ENV,
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
    const wallet = new SolanaWalletService({connection:{} as any,
      secretKeyRaw: dummySecretKeyString,
      executionEnv: LIVE_ENV,
      rpcUrl: 'https://api.mainnet-beta.solana.com'
    });

    // Saldo residual menor que a reserva de gas (0.005 SOL)
    const checkGas = wallet.validateTradeAllocation(0.0005, 0.003);
    assert.strictEqual(checkGas.allowed, false);
    assert.match(checkGas.reason || '', /Reserva de gas insuficiente/);
  });

  it('deve executar sweepEmptyTokenAccounts sem erro mesmo em ambiente sem contas ativas', async () => {
    const wallet = new SolanaWalletService({connection:{} as any,
      secretKeyRaw: dummySecretKeyString,
      executionEnv: LIVE_ENV,
      rpcUrl: 'https://api.mainnet-beta.solana.com'
    });

    (wallet as any).connection = {
      getParsedTokenAccountsByOwner: async () => ({ value: [] })
    };

    const sweepResult = await wallet.sweepEmptyTokenAccounts();
    assert.ok(typeof sweepResult.closedCount === 'number');
    assert.ok(typeof sweepResult.reclaimedSolEst === 'number');
    assert.ok(Array.isArray(sweepResult.errors));
  });
});


it('deve reconciliar saldos do SPL clÃ¡ssico e Token-2022', async () => {
  const token2022TestKeypair = Keypair.generate();
  const wallet = new SolanaWalletService({connection:{} as any,
    secretKeyRaw: JSON.stringify(Array.from(token2022TestKeypair.secretKey)),
    executionEnv: LIVE_ENV,
    rpcUrl: 'https://api.mainnet-beta.solana.com'
  });

  const seenPrograms: string[] = [];
  const fakePubkey = { toBase58: () => 'FakeAtaToken2022' };
  (wallet as any).connection = {
    getParsedTokenAccountsByOwner: async (_owner: any, filter: any) => {
      const program = filter.programId.toBase58();
      seenPrograms.push(program);
      if (program === 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb') {
        return {
          value: [{
            pubkey: fakePubkey,
            account: {
              data: {
                parsed: {
                  info: {
                    mint: 'Token2022Mint',
                    tokenAmount: {
                      uiAmount: 5245.575701,
                      amount: '5245575701',
                      decimals: 6
                    }
                  }
                }
              }
            }
          }]
        };
      }
      return { value: [] };
    }
  };

  const accounts = await wallet.getSplTokenAccounts();
  assert.ok(seenPrograms.includes('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'));
  assert.ok(seenPrograms.includes('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'));
  assert.strictEqual(accounts.length, 1);
  assert.strictEqual(accounts[0].mint, 'Token2022Mint');
  assert.strictEqual(accounts[0].atomicAmount, '5245575701');
  assert.strictEqual(accounts[0].decimals, 6);
});

it('deve usar o delta real da transação confirmada, não o outAmount esperado da quote', async () => {
  const kp = Keypair.generate();
  const owner = kp.publicKey.toBase58();
  const wallet = new SolanaWalletService({connection:{} as any,
    secretKeyRaw: JSON.stringify(Array.from(kp.secretKey)),
    executionEnv: LIVE_ENV,
    rpcUrl: 'https://api.mainnet-beta.solana.com'
  });

  (wallet as any).connection = {
    getParsedTransaction: async () => ({
      meta: {
        preTokenBalances: [],
        postTokenBalances: [{
          mint: 'GoogleMint',
          owner,
          uiTokenAmount: { amount: '5245575701' }
        }]
      }
    })
  };

  const delta = await wallet.getReceivedTokenDeltaAtomic('MockTx', 'GoogleMint');
  assert.strictEqual(delta, '5245575701');
});


it('reconcilia execução V2 incerta pelo delta real recente da wallet', async () => {
  const kp = Keypair.generate();
  const owner = kp.publicKey.toBase58();
  const wallet = new SolanaWalletService({connection:{} as any,
    secretKeyRaw: JSON.stringify(Array.from(kp.secretKey)),
    executionEnv: LIVE_ENV,
    rpcUrl: 'https://api.mainnet-beta.solana.com'
  });
  const nowSec = Math.floor(Date.now() / 1000);

  (wallet as any).connection = {
    getSignaturesForAddress: async () => [{
      signature: 'RecentV2Tx',
      blockTime: nowSec
    }],
    getParsedTransaction: async () => ({
      meta: {
        fee: 5000,
        preBalances: [1_000_000_000],
        postBalances: [984_995_000],
        preTokenBalances: [],
        postTokenBalances: [{
          mint: 'V2Mint',
          owner,
          uiTokenAmount: { amount: '123456789' }
        }]
      },
      transaction: {
        message: {
          accountKeys: [{ pubkey: kp.publicKey }]
        }
      }
    })
  };

  const found = await wallet.findRecentTokenDeltaTransaction(
    'V2Mint',
    Date.now() - 2_000,
    'IN'
  );

  assert.ok(found);
  assert.strictEqual(found?.signature, 'RecentV2Tx');
  assert.strictEqual(found?.deltaAtomic, '123456789');
  assert.strictEqual(found?.walletLamportDelta, -15_005_000);
  assert.strictEqual(found?.feeLamports, 5000);
});
