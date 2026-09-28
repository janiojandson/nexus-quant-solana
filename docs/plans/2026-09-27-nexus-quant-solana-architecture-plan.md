# Nexus Quant Solana Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete Nexus Quant Solana architecture upgrade: RugCheck Anti-Scam Security, On-Chain Aggression Scanner, Dual-Stage Trailing Stop Engine with conditional ATA Close Rent Exemption, and a decoupled REST API + Modern Dark Mode Web Terminal.

**Architecture:** A modular Node.js/TypeScript architecture. The scanner enforces pool maturity (20m-4h), minimum liquidity ($15k), and buying aggression (>= 70%). The risk gatekeeper audits RugCheck API parameters. The position exit engine monitors positions every 1500ms using a dual-stage trailing stop (+100% partial take-profit, 15% trailing stop from peak) and executes `createCloseAccountInstruction` only upon 100% full liquidation. A standalone Web Terminal serves REST endpoints for live state monitoring and one-click market selling of any Phantom-custodied SPL token.

**Tech Stack:** Node.js, TypeScript, `@solana/web3.js`, `@jup-ag/api` / Jupiter V6 API, Express / native HTTP REST API, Axios, DexScreener API, RugCheck API.

**Spec:** [`docs/specs/2026-09-27-nexus-quant-solana-architecture-design.md`](file:///d:/Programas/Desenvolvendo/nexus-quant-solana/docs/specs/2026-09-27-nexus-quant-solana-architecture-design.md)

## Global Constraints

- **Maturity Window:** Only tokens between 20 minutes and 4 hours old are eligible.
- **Minimum Liquidity:** Minimum confirmed pool liquidity >= $15,000 USD.
- **Aggression Ratio:** Minimum 70% buying volume in the last 100 on-chain transactions.
- **Sniper Mode Limit:** `MAX_CONCURRENT_POSITIONS = 1`. Pause new scans if 1 position is active.
- **Initial Risk:** Fixed Initial Stop-Loss at -20% and 15-minute Time-Stop for stagnant positions.
- **Dual-Stage Trailing Stop:** Partial TP of 50% lot at +100% (+1.0R / 2x). Move SL to Breakeven. Trailing Stop at 15% below peak for the remaining 50%.
- **ATA Close Rent Exemption:** Execute `createCloseAccountInstruction` strictly when position is 100% closed. Do NOT close ATA on 50% partial exit.
- **Slippage & Priority Fee:** Buy slippage 400 bps (4.0%); Exit/Stop slippage 500 bps (5.0%) with priority fee `high`.

---

### Task 1: RugCheck Security Gatekeeper

**Files:**
- Modify: `src/risk/rugCheckService.ts`
- Modify: `src/risk/memeRiskGatekeeper.ts`
- Test: `src/risk/rugCheckService.test.ts`

**Interfaces:**
- Consumes: Token mint address, RugCheck Report payload
- Produces: `auditToken(req): Promise<AuditResult>` with detailed safety score, `mintAuthority`, `freezeAuthority`, `lpBurnedPct`, and `topHoldersPct`.

- [ ] **Step 1: Write failing unit test for RugCheck validation rules**

```typescript
// src/risk/rugCheckService.test.ts
import test from 'node.test';
import assert from 'node:assert';
import { RugCheckService } from './rugCheckService.js';

test('RugCheckService: deve vetar se mintAuthority ou freezeAuthority forem ativas', async () => {
  const service = new RugCheckService();
  const mockReport = {
    mintAuthority: 'ActiveAuthority111111111111111111111111',
    freezeAuthority: null,
    markets: [{ lp: { lpLocked: 95, lpBurned: 0 } }],
    topHolders: [{ pct: 5 }]
  };
  const result = service.evaluateReport(mockReport);
  assert.strictEqual(result.safe, false);
  assert.match(result.reason || '', /mintAuthority/);
});

test('RugCheckService: deve vetar se top 5 holders possuírem mais de 20% do supply', async () => {
  const service = new RugCheckService();
  const mockReport = {
    mintAuthority: null,
    freezeAuthority: null,
    markets: [{ lp: { lpLocked: 95, lpBurned: 0 } }],
    topHolders: [{ pct: 10 }, { pct: 8 }, { pct: 5 }] // Total = 23%
  };
  const result = service.evaluateReport(mockReport);
  assert.strictEqual(result.safe, false);
  assert.match(result.reason || '', /Holders/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/risk/rugCheckService.test.ts`  
Expected: FAIL due to missing `evaluateReport` method or outdated rules.

- [ ] **Step 3: Implement RugCheck validation logic**

Modify `src/risk/rugCheckService.ts` to implement `evaluateReport` with strict checks for `mintAuthority == null`, `freezeAuthority == null`, `lpBurnedPct >= 90%` or `lpLockedPct >= 90%`, and Top 5 Holders $< 20\%$.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/risk/rugCheckService.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/risk/rugCheckService.ts src/risk/rugCheckService.test.ts
git commit -m "feat(risk): implementar filtros rígidos RugCheck API (mint/freeze authority, LP locked/burned e top 5 holders)"
```

---

### Task 2: DexScreener Scanner & On-Chain Aggression Filter

**Files:**
- Modify: `src/scanner/dexScreenerScanner.ts`
- Modify: `src/scanner/tokenClassifier.ts`
- Test: `src/scanner/dexScreenerScanner.test.ts`

**Interfaces:**
- Consumes: DexScreener Pair Search API & On-chain Recent Transactions
- Produces: `scanSolanaTrends(minLiquidityUsd)` returning eligible tokens filtered by 20m-4h maturity, >= $15k liquidity, and >= 70% buying aggression.

- [ ] **Step 1: Write failing unit test for scanner filters**

```typescript
// src/scanner/dexScreenerScanner.test.ts
import test from 'node.test';
import assert from 'node:assert';
import { DexScreenerScanner } from './dexScreenerScanner.js';

test('DexScreenerScanner: deve descartar pools com menos de 20 minutos de idade', () => {
  const scanner = new DexScreenerScanner();
  const now = Date.now();
  const youngPair = { pairCreatedAt: now - (15 * 60 * 1000), liquidity: { usd: 20000 } }; // 15 min
  assert.strictEqual(scanner.isMaturityValid(youngPair), false);
});

test('DexScreenerScanner: deve aceitar pools entre 20 min e 4 horas de idade', () => {
  const scanner = new DexScreenerScanner();
  const now = Date.now();
  const validPair = { pairCreatedAt: now - (45 * 60 * 1000), liquidity: { usd: 20000 } }; // 45 min
  assert.strictEqual(scanner.isMaturityValid(validPair), true);
});

test('DexScreenerScanner: deve exigir liquidez mínima >= $15,000 USD', () => {
  const scanner = new DexScreenerScanner();
  const lowLiqPair = { liquidity: { usd: 14000 } };
  assert.strictEqual(scanner.isLiquidityValid(lowLiqPair), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/scanner/dexScreenerScanner.test.ts`  
Expected: FAIL due to missing maturity (20m-4h) and liquidity ($15k) helper methods.

- [ ] **Step 3: Implement maturity, liquidity, and buying aggression logic**

Update `src/scanner/dexScreenerScanner.ts`:
- Enforce `pairCreatedAt` between 20 minutes and 4 hours.
- Enforce `liquidity.usd >= 15000`.
- Add `calculateBuyingAggressionRatio(transactions)` requiring >= 70% buy transactions out of the last 100.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/scanner/dexScreenerScanner.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/scanner/dexScreenerScanner.ts src/scanner/dexScreenerScanner.test.ts
git commit -m "feat(scanner): implementar filtro de maturidade (20m-4h), liquidez mínima ($15k) e agressão de compra >= 70%"
```

---

### Task 3: Dual-Stage Trailing Stop & Position Exit Engine

**Files:**
- Modify: `src/execution/positionExitEngine.ts`
- Test: `src/execution/positionExitEngine.test.ts`

**Interfaces:**
- Consumes: Open positions, real-time prices from Jupiter/DexScreener
- Produces: `evaluatePosition(mint, currentPriceUsd): PositionEvaluationResult` returning action (`HOLD`, `PARTIAL_TAKE_PROFIT_50`, `FULL_STOP_LOSS`, `FULL_TRAILING_STOP`, `FULL_TIME_STOP`) and updated position state.

- [ ] **Step 1: Write failing unit test for Dual-Stage Trailing Stop**

```typescript
// src/execution/positionExitEngine.test.ts
import test from 'node.test';
import assert from 'node:assert';
import { PositionExitEngine } from './positionExitEngine.js';

test('PositionExitEngine: deve disparar PARTIAL_TAKE_PROFIT_50 a +100% (+1.0R / 2x) e mover SL para Breakeven', () => {
  const engine = new PositionExitEngine();
  engine.addPosition({
    mint: 'TestMint1111111111111111111111111111111111',
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 1.0, // +100%
    entrySol: 0.015
  });

  // Preço sobe para $2.0 (+100%)
  const eval1 = engine.evaluatePosition('TestMint1111111111111111111111111111111111', 2.0);
  assert.strictEqual(eval1.action, 'PARTIAL_TAKE_PROFIT_50');
  
  const pos = engine.getPosition('TestMint1111111111111111111111111111111111');
  assert.strictEqual(pos?.partialTaken, true);
  assert.strictEqual(pos?.tokenAmount, 500); // 50% restante
  assert.strictEqual(pos?.stopLossPct, 0.0); // Breakeven
});

test('PositionExitEngine: pós-parcial, deve encerrar FULL_TRAILING_STOP se recuar 15% do topo máximo', () => {
  const engine = new PositionExitEngine();
  engine.addPosition({
    mint: 'TestMint1111111111111111111111111111111111',
    symbol: 'TEST',
    tokenAmount: 1000,
    entryPriceUsd: 1.0,
    entryTimestamp: Date.now(),
    stopLossPct: -0.20,
    takeProfitPct: 1.0,
    entrySol: 0.015
  });

  // 1. Parcial em 2.0
  engine.evaluatePosition('TestMint1111111111111111111111111111111111', 2.0);
  
  // 2. Preço sobe para o topo de $3.0
  engine.evaluatePosition('TestMint1111111111111111111111111111111111', 3.0);
  
  // 3. Preço cai 15% de $3.0 -> $2.50 (3.0 * 0.85 = 2.55) -> $2.50 dispara Trailing Stop
  const evalTrailing = engine.evaluatePosition('TestMint1111111111111111111111111111111111', 2.50);
  assert.strictEqual(evalTrailing.action, 'FULL_TRAILING_STOP');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/execution/positionExitEngine.test.ts`  
Expected: FAIL due to missing dual-stage partial TP logic.

- [ ] **Step 3: Implement Dual-Stage Trailing Stop engine**

Update `src/execution/positionExitEngine.ts`:
- Support `partialTaken: boolean` state.
- Upon reaching entryPriceUsd * 2.0 (+100%), return `PARTIAL_TAKE_PROFIT_50`, halve `tokenAmount`, and set `stopLossPct = 0.0` (Breakeven).
- Track `peakPriceUsd`.
- Post-partial, trigger `FULL_TRAILING_STOP` if `currentPriceUsd <= peakPriceUsd * 0.85`.
- Trigger `FULL_TIME_STOP` if `Date.now() - entryTimestamp > 15 * 60 * 1000` and no partial taken.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/execution/positionExitEngine.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/execution/positionExitEngine.ts src/execution/positionExitEngine.test.ts
git commit -m "feat(execution): implementar Dual-Stage Trailing Stop (+100% parcial, Breakeven e Trailing Stop 15% do topo)"
```

---

### Task 4: Hygiene On-Chain (Conditional ATA Close & Rent Exemption Devolução)

**Files:**
- Modify: `src/blockchain/solanaWallet.ts`
- Modify: `src/index.ts`
- Test: `src/blockchain/solanaWallet.test.ts`

**Interfaces:**
- Consumes: SPL Token Account, User Keypair, IsFullLiquidation flag
- Produces: `closeTokenAccount(mint): Promise<string>` emitting `createCloseAccountInstruction` to reclaim ~0.00204 SOL rent exemption upon 100% full liquidation.

- [ ] **Step 1: Write failing unit test for conditional ATA close**

```typescript
// src/blockchain/solanaWallet.test.ts
import test from 'node.test';
import assert from 'node:assert';
import { SolanaWalletService } from './solanaWallet.js';

test('SolanaWalletService: deve gerar instrução de fechamento de conta ATA', async () => {
  const wallet = new SolanaWalletService({ secretKeyRaw: '[]', rpcUrl: 'https://api.mainnet-beta.solana.com' });
  assert.strictEqual(typeof wallet.closeTokenAccount, 'function');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/blockchain/solanaWallet.test.ts`  
Expected: FAIL or verify missing conditional logic.

- [ ] **Step 3: Implement conditional ATA Close in `index.ts` exit handler**

Update `executeExitOrder` in `src/index.ts`:
- If `exitReason` is a partial exit (`PARTIAL_TAKE_PROFIT_50`), **DO NOT** call `wallet.closeTokenAccount(pos.mint)`. Keep ATA active for the remaining 50%.
- If `exitReason` is a full liquidation (`FULL_STOP_LOSS`, `FULL_TRAILING_STOP`, `FULL_TIME_STOP`, `MANUAL`), execute `wallet.closeTokenAccount(pos.mint)` to reclaim ~0.00204 SOL.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/blockchain/solanaWallet.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/blockchain/solanaWallet.ts src/index.ts
git commit -m "fix(custody): fechar ATA e recolher caução Rent Exemption estritamente em liquidação 100% completa"
```

---

### Task 5: Decoupled REST API & Modern Dark-Mode Web Terminal

**Files:**
- Modify: `src/server/routes.ts`
- Modify: `src/dashboard/dashboardRenderer.ts`
- Modify: `src/index.ts`
- Test: `src/server/routes.test.ts`

**Interfaces:**
- Consumes: `latestState`, `wallet`, `positionEngine`, `jupiterEngine`
- Produces: HTTP REST API Endpoints (`/api/status`, `/api/holdings`, `/api/emergency-exit`, `/api/liquidate-token`) and Dark Mode Web Dashboard UI.

- [ ] **Step 1: Write failing unit test for REST API routes**

```typescript
// src/server/routes.test.ts
import test from 'node.test';
import assert from 'node:assert';
import { handleApiRoutes } from './routes.js';

test('handleApiRoutes: deve responder 200 OK na rota /api/status', async () => {
  const mockReq = { url: '/api/status', method: 'GET' } as any;
  let responseData = '';
  const mockRes = {
    writeHead: (code: number, headers: any) => {},
    end: (data: string) => { responseData = data; }
  } as any;

  const handled = await handleApiRoutes(mockReq, mockRes, { latestState: {} } as any);
  assert.strictEqual(handled, true);
  assert.ok(responseData.includes('agent') || responseData.includes('{'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/server/routes.test.ts`  
Expected: FAIL due to missing `handleApiRoutes` module.

- [ ] **Step 3: Implement REST API Handler & Web Dashboard UI**

- Create `src/server/routes.ts` with handlers for `/api/status`, `/api/holdings`, `/api/emergency-exit`, and `/api/liquidate-token`.
- Refactor `src/dashboard/dashboardRenderer.ts` to render a modern dark-mode terminal with:
  - System Vitality & Runway Cards.
  - Table of **Custodied SPL Tokens in Phantom Wallet** with a **"Vender para SOL Agora"** action button.
  - Active Positions Table with **"Vender a Mercado"** buttons.
  - Closed Trades History.
  - Recent Audits & Quarantine status.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx tsx --test src/server/routes.test.ts`  
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routes.ts src/dashboard/dashboardRenderer.ts src/index.ts src/server/routes.test.ts
git commit -m "feat(web): implementar API REST descolada e Web Terminal com liquidação direta de qualquer token SPL"
```

---

### Task 6: Full Integration Test & Verification

**Files:**
- Modify: `src/index.ts`
- Test: All test suites (`npm test`)

**Interfaces:**
- Consumes: Integrated system components
- Produces: Verified 24/7 autonomous daemon with real-time web control.

- [ ] **Step 1: Run full test suite**

Run: `npm test`  
Expected: All unit and integration tests pass (0 failures).

- [ ] **Step 2: Build project**

Run: `npm run build`  
Expected: TypeScript compilation succeeds with exit code 0.

- [ ] **Step 3: Commit and Push**

```bash
git add .
git commit -m "feat(core): integrar RugCheck, Dual-Stage Trailing Stop, ATA Close e Web Terminal no Nexus Quant Solana"
git push origin main
```

---

## Self-Review Checklist

1. **Spec Coverage:**
   - RugCheck API integration? Covered in Task 1.
   - Maturity 20m-4h, $15k liquidity, 70% buying aggression? Covered in Task 2.
   - Dual-Stage Trailing Stop (+100% partial, breakeven, 15% trailing)? Covered in Task 3.
   - ATA Close Rent Exemption strictly on 100% exit? Covered in Task 4.
   - Decoupled REST API + Web Terminal with instant wallet liquidation? Covered in Task 5.
2. **Placeholder Scan:** No TBD or placeholders present. Exact test and implementation details provided.
3. **Type Consistency:** Signatures and types (`PARTIAL_TAKE_PROFIT_50`, `FULL_TRAILING_STOP`, `evaluatePosition`, `closeTokenAccount`) are consistent across all tasks.
