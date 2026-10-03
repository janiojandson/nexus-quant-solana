# nexus-quant-solana
Módulo Autônomo de Gestão Quantitativa, Staking Líquido e Estratégias Solana com API REST, Dashboard de Métricas e Telemetria para o Ecossistema Nexus Multi.

## Pump.fun Observatory

O serviço pode observar criações Pump.fun diretamente no programa on-chain, sem custodiar chave e sem enviar ordens Pump. Nesta fase, o módulo é **READ-ONLY**: captura o `CreateEvent`, registra slot/assinatura/timing, deriva a bonding curve canônica e atualiza o progresso em lotes RPC.

Configuração:

- `PUMP_OBSERVATORY_ENABLED=true|false`
- `PUMP_OBSERVATORY_REFRESH_MS=15000`
- `PUMP_OBSERVATORY_BATCH_SIZE=50`

O painel e `GET /api/status` expõem o estado em `pump`. A execução de trades continua exclusivamente no fluxo Jupiter existente; descoberta Pump não autoriza compra por si só.

## Strategy Lab multi-entry

O laboratório permanece em **SHADOW**. Cada mint pode produzir entradas independentes nas seguintes janelas; a idade real da cotação recebida é persistida junto da janela.

| Janela | Elegibilidade |
| --- | --- |
| `LAUNCH_0_15S` | Antes de 15s de idade |
| `ENTRY_30S` | De 30s até antes de 60s |
| `ENTRY_3M` | De 3min até antes de 5min |
| `ENTRY_5M` | De 5min até antes de 6min |
| `CURVE_5_15M` | De 5min a 15min, separadamente da entrada de minuto 5 |
| `NEAR_GRAD_60_80`, `NEAR_GRAD_80_95`, `NEAR_GRAD_95_100` | Faixa atual de progresso da curva |
| `POST_GRAD_0_2M`, `POST_GRAD_2_10M` | Tempo desde a graduação observada |

Entradas temporais e de graduação podem coexistir no mesmo mint. Uma cotação que termina depois de sua janela é descartada. Os horizontes de saída são 15s, 30s, 1min, 2min, 5min e 10min desde a entrada observada.

Os replays comparam `STOP_ONLY`, `BASELINE_CURRENT`, `PARTIAL_HARVEST_EARLIER`, `RUNNER_ONLY` e `TIERED_PROFIT_LOCK` sobre as mesmas cotações executáveis amostradas. O runner isolado ativa trailing de 10% a partir de +35%, sem colheita parcial. O candidato profit-lock mantém as proteções de baseline e adiciona pisos de +40%, +85%, +180% e +270% após picos de +50%, +100%, +200% e +300%. Esses pisos pertencem apenas à pesquisa; evidência futura pode rejeitá-los.

Custos de rede/prioridade são descontados uma vez na entrada e em cada venda simulada, inclusive na colheita parcial. Os custos da rota já presentes na cotação não são cobrados novamente. Vendas parciais usam frações proporcionais da cotação integral; movimentos entre amostras e preenchimentos reais continuam fora do replay. Um horizonte sem cotação de saída executável não recebe um resultado de replay baseado em uma cotação anterior.

A coleta permite no máximo uma chamada P6 por ciclo, serializa ciclos sobrepostos e prioriza saídas shadow antes de novas entradas. As proteções P0/P1 e a suspensão da pesquisa por `ExitPathHealth` continuam no controle de tráfego existente. Falhas de fonte/persistência ficam isoladas no laboratório e aparecem como `lastError: SAMPLE_FAILED` em `pumpStrategyLab`, com indicação de recuperação no painel.

Configuração existente:

- `PUMP_STRATEGY_LAB_ENABLED=true|false`
- `PUMP_STRATEGY_LAB_INTERVAL_MS=5000`
- `PUMP_STRATEGY_SHADOW_ENTRY_LAMPORTS=1000000`
- `PUMP_STRATEGY_NETWORK_FEE_LAMPORTS=5000`
- `PUMP_STRATEGY_PRIORITY_FEE_LAMPORTS=0`

Validação:

```sh
npm ci
npm test
npm run build
```

Em ambientes que impedem o socket IPC do CLI `tsx`, a mesma suíte pode ser executada com `node --import tsx --test --test-concurrency=1 src/**/*.test.ts test/**/*.test.ts`.
