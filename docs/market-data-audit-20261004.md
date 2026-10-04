# Auditoria de dados e uso das ferramentas ? 2026-10-04
## Evid?ncia e alcance
Logs recentes dos deployments Solana 055ae4f1 e Robinhood f7f7d36d, ambos SUCCESS. Amostra limitada: 501 linhas por servi?o; Solana 01:52?02:02 UTC, Robinhood 01:45?02:02 UTC. N?o representa todo o per?odo ap?s implanta??o nem permite estimar rentabilidade.
Relat?rios hist?ricos consultados precedem os PRs Solana #3 e Robinhood #2; n?o usar suas pend?ncias antigas como estado atual.

## Achados corrigidos
Solana: cooldown por mint era aplicado durante a avalia??o de cada pool. Um pool rejeitado podia ocultar outro pool v?lido. Deduplica??o tamb?m ocorria antes dos filtros de momentum. Agora somente candidatos aceitos s?o deduplicados e cooldown ? aplicado ap?s todas as avalia??es, somente a mints n?o aceitos. Liquidez ausente/n?o finita/negativa fica como MARKET_DATA_WAIT, sem trat?-la como zero confirmado.
Robinhood: sele??o de pool preferido ocorria sem validar chainId e baseToken. Agora pre?o/liquidez somente podem vir da rede robinhood e do token-base solicitado; modo estrito preserva aus?ncia de dados quando o pool exato n?o ? encontrado.
Testes completos: Solana 323 aprovados; Robinhood 62 aprovados. Builds aprovados. Testes com dados simulados, sem ordens.

## Filtros e oportunidades
Solana: descoberta real ainda restringe pools a 5?60 minutos; liquidez m?nima US$15 mil; m5 entre +3 e +85 quando informado; contagem compradora >= vendedora; gates on-chain posteriores. Logs exibem vetos RugCheck LP 0% e top5 99,1%. N?o foi comprovado se representam cust?dia de protocolo ou holders econ?micos; n?o excluir endere?os pelo nome/sufixo.
Robinhood: indexa??o, liquidez US$15 mil, alta de 5m >80%, falta de rota e momentum. Com quatro amostras, ceil(3*0.67)=3 exige todos os intervalos positivos. Comparar 2/3 vs 3/3 em SHADOW, considerando custos e sa?da, antes de recalibrar.
Contagem de transa??es n?o equivale a fluxo financeiro; compras pequenas repetidas podem distorcer o ratio.

## Uso h?brido recomendado
Pump: evento de cria??o, reservas reais/virtuais, est?gio da curva, migra??o, fluxo e concentra??o com identifica??o verificada de contas de protocolo.
Jupiter: cota??o no tamanho real, rota de compra e venda, impacto, slippage, lat?ncia e custo de ida e volta. Cota??o n?o garante fill nem vendabilidade futura.
Pump permite negocia??o direta antes de indexa??o Jupiter. N?o existe depend?ncia universal de Jupiter; o caminho direto exige executor buy/sell, simula??o, valida??o de programa/contas e reconcilia??o pr?prios.
Robinhood usa equivalentes EVM: eventos de pools + dados on-chain + Uniswap; Pump/Jupiter n?o roteiam seus tokens EVM.
Prioridades de pesquisa: comparar curva inicial, pr?-migra??o e p?s-migra??o; medir resultado posterior tamb?m dos rejeitados; testar momentum 2/3, reteste ap?s explos?o e ranking por fluxo em volume. Avaliar fora da amostra com perdas, taxas, rotas ausentes e oportunidades n?o execut?veis inclu?das.

## Laya e sa?das
Health da Laya no Solana aparece saud?vel (35?39ms na amostra), mas health n?o comprova chamadas por candidato nem vantagem financeira. Manter advisory; medir cobertura, lat?ncia e resultado incremental pareado.
C?digo j? possui trailing/parciais e prote??o por liquidez no Robinhood, al?m de trailing e watermarks no Solana. N?o afirmar que trailing estava ausente. O caso Tesla exige mint, transa??es e hist?rico de cota??es/estado para determinar causa; n?o foi reproduzido nesta rodada.
10% ? sizing, n?o perda m?xima. Stop/trailing dependem de rota e liquidez, e n?o garantem pre?o final.
Teto 750 bps preservado; n?o foram alteradas regras de capital, execu??o, Laya, stop ou gates antifraude.

## Estado da entrega
Corre??es implementadas e testadas em branches fix/market-data-audit-20261004. Publica??o/deployment devem ser confirmados separadamente. N?o h? prova de vantagem lucrativa nem execu??o direta Pump entregue por esta corre??o.
