# SDD ledger — plan: docs/plans/2026-09-28-funil-ayla-zero-cost-pipeline.md

## Pre-flight Plan Scan
| Tasks | Interface / Arquivo | Conflitos Encontrados | Parecer |
|---|---|---|---|
| Task 1 | `scripts/test-ayla-pipeline.ts` | Nenhum (script novo isolado) | Aprovado |
| Task 2 -> Task 3 | `MintCooldownCache` -> `DexScreenerScanner` | `shouldProcess(mint)` e `recordRejection(mint)` casam exatamente com o scanner | Aprovado |
| Task 4 | `PositionExitEngine` | Novos patamares (-8%, +12%, +35%, -10%) testados com TDD | Aprovado |
| Task 5 | `index.ts` | `buyAmountSol = 0.05` respeita o saldo de 0.29 SOL e gas reserve 0.05 SOL | Aprovado |
| Task 6 | Regressão Geral | 57 testes devem permanecer verdes | Aprovado |

Task 1: complete (commit a99be10, test harness functional)
Task 2: complete (commit c7174c6, MintCooldownCache unit tests passing)
Task 3: complete (commit 4944c5e, scanner reoriented to new_pools + 15-60m window + $20k liquidity)
Task 4: complete (commit ccf14b2, positionExitEngine calibrated with SL -8%, Breakeven +12%, Parcial +35%, Trailing -10%)
Task 5: complete (commit 5c41079, position sizing set to 0.05 SOL with 0.05 SOL reserve)
Task 6: complete (61/61 tests passing, tsc --noEmit 0 errors, pipeline harness validated)
