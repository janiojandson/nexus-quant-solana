import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AgentReachClient } from './agentReachClient.js';

describe('AgentReachClient - Presença Multicanal X e Instagram', () => {
  const dummyWallet = 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';

  it('deve formatar post viral contendo a carteira Phantom oficial para captação de gorjetas/tips', async () => {
    const client = new AgentReachClient({ officialWalletAddress: dummyWallet });
    const post = client.formatAlphaPost({
      tokenSymbol: 'PEPE_SOL',
      mintAddress: 'TokenMintAddress123',
      narrative: 'Baleia acumulou 15% do supply e liquidez travada',
      targetGainX: '3x'
    });

    assert.ok(post.includes('PEPE_SOL'));
    assert.ok(post.includes('3x'));
    assert.ok(post.includes(dummyWallet));
    assert.ok(post.includes('#Solana'));
  });

  it('deve simular publicacao no X e Instagram retornando status de sucesso', async () => {
    const client = new AgentReachClient({ officialWalletAddress: dummyWallet });
    const result = await client.publishPost({
      platform: 'X',
      content: 'Solana alpha call com book favoravel'
    });

    assert.strictEqual(result.success, true);
    assert.ok(result.postId);
  });

  it('deve truncar ou sanitizar textos que excedam o limite de caracteres de cada plataforma', () => {
    const client = new AgentReachClient({ officialWalletAddress: dummyWallet });
    const longText = 'A'.repeat(400);
    const sanitized = client.sanitizePostContent(longText, 'X');
    assert.ok(sanitized.length <= 280);
  });
});
