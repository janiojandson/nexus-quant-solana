# SDD ledger — plan: docs/plans/2026-09-28-funil-ayla-zero-cost-pipeline.md

## Pre-flight Plan Scan
| Tasks | Interface / Arquivo | Conflitos Encontrados | Parecer |
|---|---|---|---|
| Task 1 | `scripts/test-ayla-pipeline.ts` | Nenhum (script novo isolado) | Aprovado |
| Task 2 -> Task 3 | `MintCooldownCache` -> `DexScreenerScanner` | `shouldProcess(mint)` e `recordRejection(mint)` casam exatamente com o scanner | Aprovado |
| Task 4 | `PositionExitEngine` | Novos patamares (-8%, +12%, +35%, -10%) testados com TDD | Aprovado |
| Task 5 | `index.ts` | `buyAmountSol = 0.05` respeita o saldo de 0.29 SOL e gas reserve 0.05 SOL | Aprovado |
| Task 6 | Regressão Geral | 57 testes devem permanecer verdes | Aprovado |
