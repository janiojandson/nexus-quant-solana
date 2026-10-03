# nexus-quant-solana
Módulo Autônomo de Gestão Quantitativa, Staking Líquido e Estratégias Solana com API REST, Dashboard de Métricas e Telemetria para o Ecossistema Nexus Multi.

## Pump.fun Observatory

O serviço pode observar criações Pump.fun diretamente no programa on-chain, sem custodiar chave e sem enviar ordens Pump. Nesta fase, o módulo é **READ-ONLY**: captura o `CreateEvent`, registra slot/assinatura/timing, deriva a bonding curve canônica e atualiza o progresso em lotes RPC.

Configuração:

- `PUMP_OBSERVATORY_ENABLED=true|false`
- `PUMP_OBSERVATORY_REFRESH_MS=15000`
- `PUMP_OBSERVATORY_BATCH_SIZE=50`

O painel e `GET /api/status` expõem o estado em `pump`. A execução de trades continua exclusivamente no fluxo Jupiter existente; descoberta Pump não autoriza compra por si só.
