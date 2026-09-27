import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AgentTubeEngine } from './agentTubeEngine.js';

describe('AgentTubeEngine - Pipeline de Vídeos Curtos para YouTube Shorts', () => {
  const dummyWallet = 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';

  it('deve gerar roteiro de vídeo curto com gancho forte nos primeiros 3 segundos', async () => {
    const engine = new AgentTubeEngine({ officialWalletAddress: dummyWallet });
    const script = engine.generateShortScript({
      tokenName: 'SOL_DOGE',
      gainPercentage: 450,
      holdingReason: 'Baleias travaram o pool na Raydium'
    });

    assert.ok(script.hook.includes('450%'));
    assert.ok(script.body.includes('SOL_DOGE'));
    assert.ok(script.callToAction.includes(dummyWallet));
    assert.ok(script.estimatedDurationSeconds <= 60);
  });

  it('deve simular upload e agendamento de vídeo no YouTube Shorts', async () => {
    const engine = new AgentTubeEngine({ officialWalletAddress: dummyWallet });
    const upload = await engine.publishShortVideo({
      title: 'Essa Memecoin na Solana explodiu 450%!',
      description: 'Análise gerada pelo agente autônomo Nexus.',
      tags: ['solana', 'crypto', 'memecoins', 'shorts']
    });

    assert.strictEqual(upload.success, true);
    assert.ok(upload.videoId);
    assert.ok(upload.youtubeUrl.includes('youtube.com/shorts'));
  });
});
