# Estratégias complementares sem Laya

Objetivo aprovado: retirar dependência operacional da Laya e concentrar os serviços em dados observáveis, regras explícitas, comunicação verificável e execução. Não há promessa de lucro ou de proteção absoluta contra perdas.

## 1. Responsabilidades

| Serviço/caminho | Descoberta | Entrada | Proteção |
|---|---|---|---|
| Sentinel, bonding curve | PumpPortal + leitura de reservas Helius | Política compartilhada abaixo; swap nativo Pump.fun | ExitEngine de curva, dev dump, breakeven e parciais existentes |
| Sentinel → Quant | Observação de curva >=70%, até100%, dev RPC <=5%, blacklist negativa | Handoff é candidato, não ordem nem certificado de segurança | Quant grava outcome de compra/descarte |
| Quant, pós-graduação | Poll PostgreSQL 3s; rota Jupiter a cada2s por até45s | Cotação executável .025SOL, impacto absoluto conhecido <=2,5%, pool auditável, RugCheck e sizing | Mesma execução protegida Jupiter; slots exclusivos Sentinel |
| Quant, DEX convencional | DEX search + GeckoTerminal/incubadora | Pool5–60min, liq >=15k, M5+3..85, fluxo comprador, RugCheck e micro-momentum Jupiter | Slots exclusivos DEX, limites de capital e saídas existentes |

Comprar na curva e comprar após a graduação são estratégias distintas. Curva70% não significa migração concluída. A ausência de rota executável impede a compra no Quant. A compra própria do Sentinel não é necessária para enviar o candidato.

## 2. Entrada própria do Sentinel

Os caminhos PumpPortal e Helius passam pelo mesmo `evaluateEntryFilters` e pela mesma função pura `evaluateCurveEntry`. O Helius fornece um snapshot, sem bypass de filtros por nome de evento.

Regras preservadas: idade >=60s, curva15–40% inclusive, >=20 compradores únicos observados, impacto de compra <=3,5%, participação atual do dev RPC <=5%, fora de blacklist, reservas válidas/positivas. Dados ausentes, NaN ou dev desconhecido não viram zero nem aprovação.

O caminho antigo Helius não verificava explicitamente compradores/impacto como o outro caminho. Essa divergência foi corrigida. A maturação de60s é uma regra deliberada, não atraso da API.

Para obter compradores reais, candidatas na faixa15–40% recebem assinatura de negócios PumpPortal por até120s, no máximo100 assinaturas de observação simultâneas. Fora da faixa, assinaturas sem posição são liberadas. Assinaturas de posições abertas continuam para gestão de saída. Mensagem de trade de mint desconhecido não inventa creator nem horário de criação.

Admissão: no máximo2 posições/pedidos em andamento locais; lote <=MAX_POSITION_SOL e <=10% do saldo; reserva mínima0,008SOL além dos lotes em andamento para gás/contas. Reserva por mint antes dos awaits impede dupla compra. Falha de dados bloqueia apenas a tentativa. Falha de envio/confirmacão mantém o mint reservado contra reenvio cego e exige reconciliação; o feed registra isso. Não existe lock global de carteira entre os dois processos: limites são locais e o saldo é consultado antes da entrada.

Compra usa preflight RPC e aguarda confirmação `confirmed` antes de abrir uma posição gerida. Uma simulação com erro não pode ser tratada como compra bem-sucedida. A assinatura é reservada antes do transporte: timeout mantém novas entradas bloqueadas enquanto uma reconciliação a cada2s verifica confirmação ou expiração finalizada, sem reenviar. O preço médio de entrada é congelado na cotação submetida, não nas reservas mutáveis após a confirmação; ainda é estimativa, não custo final reconciliado. Reservas/posições são em memória: recuperação completa após reinício exige persistência adicional e não está sendo declarada nesta entrega.

## 3. Entrada do Quant

### DEX

DEX é atualmente fonte de triagem, não sensor de micro-preço. A validação pré-swap usa duas cotações Jupiter do mesmo lote, separadas por1s, com consistência de rota/pool, impacto conhecido <=2,5%, alta mínima0,4%, teto4% e pullback máximo0,3% conforme implementação existente. Sem confirmação positiva, rejeita. Esta política é seletiva; não foi relaxada para fabricar volume.

### Sentinel

Sem gate de candles/micro-preços DEX. Tenta rota Jupiter em intervalos2s, janela45s, impacto conhecido <=2,5%; depois auditoria na pool da rota. Risco exige autoridades revogadas, LP >=90%, Top5<=35%, fatos críticos completos e demais hard gates. Sizing pode reduzir lote dentro da política existente. Unknown/429 é indisponibilidade técnica, não prova de golpe. Os retries/cooldowns técnicos existentes permanecem limitados e fail-closed.

Slots Quant:2DEX+2Sentinel, com reservas de admissão. Capital compartilhado dentro do Quant pode impedir entrada mesmo havendo slot livre; o motivo deve ser operacional, não suposto veto de IA.

## 4. Saídas e risco

Não alterados nesta migração: stop inicial−12,5% no Quant, colapso severo−30%, early trailing ativado após+8% e distância6%, runner/trailing e escada de parciais existentes. Stop é gatilho, não garantia de preço final.

Sentinel no Quant tem janela base90min, perda de tempo após90min conforme regra existente e teto105min; stop/trailing/emergências continuam ativos antes disso. Portanto90min não é tempo mínimo garantido de permanência. DEX mantém a política temporal própria. O Sentinel nativo mantém os stops/TP de curva e proteção de migração existentes, separados da política pós-graduação.

## 5. Contrato de comunicação e observabilidade

`sentinel_handoff` continua compatível. Coluna histórica `laya_score` passa aNULL nos novos registros, sem apagar histórico. Status `GRADUATING_HIGH_STRENGTH` indica condição de radar. `consumed_by_quant` marca captura, enquanto `quant_outcome`/detail indicam decisão real. Nenhuma tela deve mostrar handoff como compra própria.

Nova tabela `sentinel_entry_decisions` guarda mint, símbolo, aprovação, motivo e timestampTIMESTAMPTZ. Motivos incluem MATURITY_60S, CURVE_OUTSIDE_15_40, UNIQUE_BUYERS_LT_20, DATA_UNAVAILABLE, DEV_SHARE_EXCEEDED, PRICE_IMPACT_EXCEEDED e limites operacionais. Repetição do mesmo motivo para um mint é deduplicada até a condição mudar. Painel mostra regras e últimos desfechos, não score de IA rebatizado.

Quant expõe modo determinístico e telemetria agregada do hub: número de chaves, filas, requisições concluídas e429. Nenhuma chave é exposta. O histórico de Laya no banco permanece histórico; clientes legados/testes de contrato não são importados no runtime.

## 6. Atraso e velocidade

Snapshot real08/10/2026 00:39BRT: observatório on-chain ativo,1709 criações observadas desde boot,200 observações recentes;38 também encontradas no DEX. Entre essas38, intervalo entre observação on-chain e primeira resposta positiva DEX14,243–74,368s;6 acima60s. O valor inclui o polling e o tamanho/ordenação do lote; não isola atraso do provedor nem mede idade de preço. Não extrapolar amostra selecionada aos tokens não indexados.

O código de correlação examina até30 candidatas por lote e privilegia recentes; candidatas antigas podem esperar ou ficar sem amostra. `pairCreatedAt` é criação da pool, não timestamp da atualização do preço. Repetição de preço não prova ausência de swaps nem latência específica do cache. A documentação pública DEX não estabelece um SLA de atualização subsegundo: https://docs.dexscreener.com/api/reference.

O próprio scanner DEX exige5min de pool e tem scan default30s; portanto não implementa sniper instantâneo. Reduzir esse mínimo sem outra fonte/regras muda a estratégia, não corrige indexação.

Para oportunidades Pump.fun, eventos nativos existentes dão um caminho anterior ao DEX. Para oportunidades fora da Pump.fun, descoberta instantânea ampla exigiria listeners de criação de pools específicos por programa, parsing/validação e medição; não está sendo alegada como implementada nesta entrega. Não se substitui descoberta de mints por Jupiter, que precisa de mint conhecido e rota indexada.

Hub atual conserva rotação entre organizações independentes, filas por organização e prioridade de proteção/saída. Aumenta capacidade útil sob limites reais; não remove o tempo de HTTP, indexação Jupiter, RPC e confirmação. Intervalo nominal1.500ms não garante um quote novo nesse prazo sob carga. Medir filas,429 e tempo quote-to-send antes de aumentar frequência. Não há uso de chaves de organizações diferentes como prova de disponibilidade ilimitada.

## 7. Validação econômica pendente

Comparar separadamente DEX, curva e pós-graduação, por versão de estratégia, com compras/vendas confirmadas e todas as parciais. A contabilidade antiga de rent/taxas e sobrescrita de parciais ainda precisa de correção em tarefa própria antes de declarar lucro líquido confiável. Mais trades não equivalem a mais oportunidades lucrativas. A presente entrega elimina dependência de IA e torna regras auditáveis; não prova alpha.
