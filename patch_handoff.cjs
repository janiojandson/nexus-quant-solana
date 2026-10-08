const fs = require('fs');
const path = require('path');

const targetFile = path.join(__dirname, 'src', 'scanner', 'sentinelHandoffScanner.ts');
let content = fs.readFileSync(targetFile, 'utf8');

content = content.replace(
  `import { EventEmitter } from 'events';`,
  `import { EventEmitter } from 'events';\nimport { HeliusRpcHub } from '../hubs/heliusRpcHub.js';`
);

content = content.replace(
  `  private readonly pollingIntervalMs: number;`,
  `  private readonly pollingIntervalMs: number;\n  private rpcHub: HeliusRpcHub | null = null;\n  private incubator = new Map<string, { addedAt: number }>();`
);

content = content.replace(
  `  constructor(pgPool: Pool | null, options: { pollingIntervalMs?: number } = {}) {`,
  `  constructor(pgPool: Pool | null, options: { pollingIntervalMs?: number, rpcHub?: HeliusRpcHub } = {}) {`
);

content = content.replace(
  `    this.pollingIntervalMs = options.pollingIntervalMs ?? 3_000;`,
  `    this.pollingIntervalMs = options.pollingIntervalMs ?? 3_000;\n    if (options.rpcHub) this.rpcHub = options.rpcHub;`
);

content = content.replace(
  `status = 'GRADUATING_HIGH_STRENGTH'`,
  `status = 'CANDIDATE'`
);

content = content.replace(
  `aguardando tokens GRADUATING_HIGH_STRENGTH`,
  `aguardando tokens CANDIDATE (Incubadora)`
);

// We need to intercept the emission, so inside the loop:
// Replace this block:
/*
          console.log(
            `[SentinelHandoff] Token pre-auditado capturado: ${token.symbol} (${token.mint}) ` +
            `| LayaScore=${token.layaScore ?? 'N/D'} | PnL%=${token.pnlPercent ?? 'N/D'} ` +
            `| Criado em ${token.createdAt.toISOString()}`
          );

          this.emit('sentinelGraduationToken', token);
*/
// With the incubator logic. But wait, if we lock it in DB, we should just store the token in the incubator.
// Then we have a second step in poll() to check the incubator via rpcHub.
// So let's just replace the whole poll() method.

const pollRegex = /private async poll\(\): Promise<void> \{[\s\S]*?this\.isPolling = false;\n    \}\n  \}/m;

const newPoll = `private async poll(): Promise<void> {
    if (this.isPolling || !this.pgPool) return;
    this.isPolling = true;
    try {
      const candidates = await this.pgPool.query<{
        mint: string;
        symbol: string;
        dev_wallet: string | null;
        laya_score: string | null;
        pnl_percent: string | null;
        created_at: Date;
      }>(\`
        SELECT mint, symbol, dev_wallet, laya_score, pnl_percent, created_at
        FROM sentinel_handoff
        WHERE status = 'CANDIDATE'
          AND consumed_by_quant = FALSE
          AND created_at > NOW() - INTERVAL '15 minutes'
        ORDER BY created_at ASC
        LIMIT 5;
      \`);

      for (const row of candidates.rows) {
        try {
          const lockResult = await this.pgPool.query(
            \`UPDATE sentinel_handoff
             SET consumed_by_quant = TRUE, consumed_at = NOW()
             WHERE mint = $1 AND consumed_by_quant = FALSE\`,
            [row.mint]
          );

          if ((lockResult.rowCount ?? 0) !== 1) continue;

          const token: SentinelHandoffToken = {
            mint: row.mint,
            symbol: row.symbol || row.mint.slice(0, 6),
            devWallet: row.dev_wallet,
            layaScore: row.laya_score !== null ? Number(row.laya_score) : null,
            pnlPercent: row.pnl_percent !== null ? Number(row.pnl_percent) : null,
            createdAt: row.created_at,
            isSentinelPreAudited: true
          };

          this.incubator.set(row.mint, { addedAt: Date.now(), token });
          console.log(\`[SentinelHandoff] Incubando CANDIDATE: \${token.symbol} (\${token.mint})\`);
        } catch (lockErr: any) {
          console.warn(\`[SentinelHandoff] Falha ao fazer lock de \${row.mint}: \${lockErr?.message || lockErr}\`);
        }
      }
      
      if (this.rpcHub) {
        await this.verifyRaydiumPools();
      }
    } catch (err: any) {
      if (!String(err?.message || '').includes('does not exist')) {
        console.warn(\`[SentinelHandoff] Polling erro: \${err?.message || err}\`);
      }
    } finally {
      this.isPolling = false;
    }
  }

  private async verifyRaydiumPools() {
    if (!this.rpcHub) return;
    const now = Date.now();
    for (const [mint, data] of this.incubator.entries()) {
      if (now - data.addedAt > 60000) {
        this.incubator.delete(mint);
        continue;
      }
      try {
        const response = await this.rpcHub.request('STATE', 'getAsset', [mint]);
        if (response.status === 200 && response.body?.token_info?.price_info) {
          console.log(\`[SentinelHandoff] Pool confirmada on-chain para \${mint}. Avançando...\`);
          this.emit('sentinelGraduationToken', data.token);
          this.incubator.delete(mint);
        }
      } catch (err) {
        // Pool probably doesn't exist yet
      }
    }
  }`;

content = content.replace(pollRegex, newPoll);

// We need to add `token: SentinelHandoffToken` to the Map definition.
content = content.replace(
  `private incubator = new Map<string, { addedAt: number }>();`,
  `private incubator = new Map<string, { addedAt: number, token: SentinelHandoffToken }>();`
);

content = content.replace(
  `row.status === 'GRADUATING_HIGH_STRENGTH'`,
  `row.status === 'CANDIDATE' || row.status === 'GRADUATING_HIGH_STRENGTH'`
);

fs.writeFileSync(targetFile, content);
console.log('Patched sentinelHandoffScanner.ts');
