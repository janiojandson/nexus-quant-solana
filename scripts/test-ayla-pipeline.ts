import axios from 'axios';

interface PoolData {
  id: string;
  type: string;
  attributes: {
    address: string;
    name: string;
    pool_created_at: string;
    base_token_price_usd?: string;
    reserve_in_usd: string;
    volume_usd?: { h1?: string; m5?: string; h24?: string };
    transactions?: {
      m5?: { buys: number; sells: number };
      h1?: { buys: number; sells: number };
    };
  };
  relationships?: {
    base_token?: {
      data?: { id: string; type: string };
    };
  };
}

export async function simularFunilAyla(): Promise<{
  totalPools: number;
  aprovadosIdade: number;
  aprovadosLiquidez: number;
  aprovadosAyla: number;
}> {
  console.log('🔍 [TEST HARNESS] Iniciando auditoria do funil da Ayla em tempo real...');

  const response = await axios.get('https://api.geckoterminal.com/api/v2/networks/solana/new_pools', {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
      'Accept': 'application/json'
    },
    timeout: 10000
  });

  const pools: PoolData[] = response.data?.data || [];
  console.log(`📦 Piscinas recebidas: ${pools.length}`);

  const agora = Date.now();
  let aprovadosIdade = 0;
  let aprovadosLiquidez = 0;
  let aprovadosAyla = 0;

  for (const pool of pools) {
    const rawMint = pool.relationships?.base_token?.data?.id || '';
    const mint = rawMint.replace(/^solana_/, '');
    const createdAt = new Date(pool.attributes.pool_created_at).getTime();
    const idadeMinutos = (agora - createdAt) / (1000 * 60);
    const liquidez = parseFloat(pool.attributes.reserve_in_usd || '0');
    const buysM5 = pool.attributes.transactions?.m5?.buys || 0;
    const sellsM5 = pool.attributes.transactions?.m5?.sells || 0;
    const totalTradesM5 = buysM5 + sellsM5;

    // Filtro 1: Janela de Maturação (15 a 60 min)
    if (idadeMinutos < 15 || idadeMinutos > 60) continue;
    aprovadosIdade++;

    // Filtro 2: Liquidez Mínima ($20.000)
    if (liquidez < 20000) continue;
    aprovadosLiquidez++;

    // Filtro 3: Dominância Compradora da Ayla (Buys >= 65% e buys >= sells * 1.5)
    const pressaoCompradora = totalTradesM5 > 0 ? (buysM5 / totalTradesM5) * 100 : 0;
    const sinalAyla = pressaoCompradora >= 65 && buysM5 >= sellsM5 * 1.5;

    console.log(`\n🎯 Candidato: ${pool.attributes.name}`);
    console.log(`   - Pool AMM: ${pool.attributes.address}`);
    console.log(`   - Token Mint: ${mint || 'N/A'}`);
    console.log(`   - Idade: ${idadeMinutos.toFixed(1)} min`);
    console.log(`   - Liquidez: $${liquidez.toLocaleString()}`);
    console.log(`   - Trades 5m: ${buysM5} compras / ${sellsM5} vendas (${pressaoCompradora.toFixed(1)}% dominância)`);
    console.log(`   - Status Ayla (+EV): ${sinalAyla ? '✅ APROVADO' : '❌ VETADO'}`);

    if (sinalAyla) aprovadosAyla++;
  }

  console.log('\n================ RESUMO DO DIAGNÓSTICO ================');
  console.log(`Recebidas:            ${pools.length}`);
  console.log(`Na janela (15-60 min): ${aprovadosIdade}`);
  console.log(`Com liquidez > $20k:   ${aprovadosLiquidez}`);
  console.log(`Elegíveis para Ayla:    ${aprovadosAyla}`);
  console.log('=======================================================');

  return { totalPools: pools.length, aprovadosIdade, aprovadosLiquidez, aprovadosAyla };
}

if (process.argv[1]?.includes('test-ayla-pipeline')) {
  simularFunilAyla().catch((err) => {
    console.error('❌ Erro no teste de pipeline:', err.message);
  });
}
