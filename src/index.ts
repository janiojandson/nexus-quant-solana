import dotenv from 'dotenv';
import { VitalityEngine, VitalityState, getAgentVitalityState } from './core/vitalityEngine.js';
import { SolanaWalletService } from './blockchain/solanaWallet.js';
import { DexAggregatorService } from './blockchain/dexAggregator.js';
import { MemeRiskGatekeeper } from './risk/memeRiskGatekeeper.js';
import { AgentReachClient } from './social/agentReachClient.js';
import { AgentTubeEngine } from './social/agentTubeEngine.js';
import { ReproductionEngine } from './lifecycle/reproductionEngine.js';

dotenv.config();

const OFFICIAL_PHANTOM_WALLET = process.env.AGENT_SOLANA_PUBLIC_KEY || 'FBx2SKLDLsdeLM8owxU8MNVPKAfJpLpmpHHRgiZDqBoi';
const SECRET_KEY_RAW = process.env.AGENT_SOLANA_PRIVATE_KEY || '[]';

async function main() {
  console.log('====================================================');
  console.log('🚀 NEXUS QUANT SOLANA - AGENTE SOBERANO DARWINISTA');
  console.log(`🪙 Carteira Phantom Oficial: ${OFFICIAL_PHANTOM_WALLET}`);
  console.log('====================================================');

  // Inicializacao dos Motores
  const wallet = new SolanaWalletService({
    secretKeyRaw: SECRET_KEY_RAW,
    rpcUrl: process.env.SOLANA_RPC_URL
  });

  const dex = new DexAggregatorService();
  const gatekeeper = new MemeRiskGatekeeper({
    layaBaseUrl: process.env.LAYA_INTERNAL_URL || 'http://nexus-decisor-laya.railway.internal:8080',
    timeoutMs: 4000 // Acomoda confortavelmente o tempo da Ayla
  });

  const social = new AgentReachClient({ officialWalletAddress: OFFICIAL_PHANTOM_WALLET });
  const tube = new AgentTubeEngine({ officialWalletAddress: OFFICIAL_PHANTOM_WALLET });
  const reproduction = new ReproductionEngine();

  // Ciclo 1: Leitura de Vitalidade
  const balanceSol = await wallet.getBalanceSol();
  const vitalityState = getAgentVitalityState(balanceSol);
  console.log(`📊 Saldo On-Chain: ${balanceSol.toFixed(4)} SOL | Estado Vital: [${vitalityState}]`);

  if (vitalityState === VitalityState.DEAD) {
    console.warn('⚠️ Processo em inanição de saldo. Operação pausada aguardando aporte na Phantom.');
  }

  // Ciclo 2: Verificacao de Reproducao / Saque 50/50
  if (reproduction.canReproduce(balanceSol)) {
    const split = reproduction.calculateSurplusSplit({
      currentBalanceSol: balanceSol,
      reserveOperatingBalanceSol: 0.20
    });
    console.log(`🎉 PROSPERIDADE! Saque Janio: ${split.profitShareJanioSol} SOL | Alocação Filho: ${split.childInitialStakeSol} SOL`);
    const child = await reproduction.spawnChildAgent('MEME_HUNTER');
    console.log(`👶 Subagente Filho Parido: ${child.childPublicKey} (${child.specialty})`);
  }

  console.log('✅ Orquestrador inicializado com sucesso.');
}

main().catch(err => {
  console.error('❌ Falha fatal no orquestrador:', err);
});
