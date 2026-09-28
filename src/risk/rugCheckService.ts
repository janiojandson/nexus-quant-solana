import axios from 'axios';

export interface RugCheckReport {
  mint: string;
  score: number;
  risks: string[];
  isRugged: boolean;
  isSafe: boolean;
  verified: boolean;
  lpLockedPct?: number;
  topHoldersPct?: number;
}

export interface RugCheckOptions {
  fetchClient?: (url: string) => Promise<{ data: any }>;
}

export class RugCheckService {
  private fetchClient: (url: string) => Promise<{ data: any }>;
  private static readonly RUGCHECK_BASE_URL = 'https://api.rugcheck.xyz/v1/tokens';
  public static readonly DANGER_SCORE_THRESHOLD = 500;

  constructor(options?: RugCheckOptions) {
    this.fetchClient = options?.fetchClient || (async (url: string) => axios.get(url, {
      timeout: 8000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'NexusQuantSolana/1.0' }
    }));
  }

  public async auditToken(mint: string): Promise<RugCheckReport> {
    try {
      const url = `${RugCheckService.RUGCHECK_BASE_URL}/${mint}/report/summary`;
      const response = await this.fetchClient(url);
      const data = response.data || {};

      const score = Number(data.score || 0);
      const rawRisks = Array.isArray(data.risks) ? data.risks : [];
      const riskNames = rawRisks.map((r: any) => typeof r === 'string' ? r : (r.name || r.description || 'Risco não especificado'));

      const isMintAuthActive = Boolean(data.token?.mintAuthority);
      const isFreezeAuthActive = Boolean(data.token?.freezeAuthority);
      const isRugged = Boolean(data.rugged) || isMintAuthActive || isFreezeAuthActive;

      // Extração de métricas de LP trancada/queimada e concentração dos top 5 holders
      let lpLockedPct = 100;
      if (Array.isArray(data.markets)) {
        const raydiumMarket = data.markets.find((m: any) => m.lp);
        if (raydiumMarket?.lp) {
          const locked = Number(raydiumMarket.lp.lpLockedPct || raydiumMarket.lp.lpLocked || 0);
          const burned = Number(raydiumMarket.lp.lpBurnedPct || raydiumMarket.lp.lpBurned || 0);
          lpLockedPct = Math.max(locked, burned);
        }
      }

      let topHoldersPct = 0;
      if (Array.isArray(data.topHolders)) {
        // Avalia a concentração dos Top 5 Holders (risco de Dev Dump)
        topHoldersPct = data.topHolders.slice(0, 5).reduce((acc: number, h: any) => acc + Number(h.pct || 0), 0);
      }

      // Token seguro apenas se score < 500, não for rugged, LP trancada/queimada >= 90% e top 5 holders <= 20%
      const isLpLockedOk = lpLockedPct >= 90;
      const isHoldersConcentrationOk = topHoldersPct <= 20;
      const isSafe = !isRugged && score < RugCheckService.DANGER_SCORE_THRESHOLD && isLpLockedOk && isHoldersConcentrationOk;

      if (!isLpLockedOk) {
        riskNames.push(`LP Trancada/Queimada insuficiente (${lpLockedPct.toFixed(1)}% < 90% exigido)`);
      }
      if (!isHoldersConcentrationOk) {
        riskNames.push(`Concentração excessiva de Top 5 Holders (${topHoldersPct.toFixed(1)}% > 20% limite)`);
      }

      return {
        mint,
        score,
        risks: riskNames,
        isRugged,
        isSafe,
        verified: Boolean(data.verification?.verified),
        lpLockedPct,
        topHoldersPct
      };
    } catch (err: any) {
      // Fallback em caso de timeout de rede: proteção defensiva
      return {
        mint,
        score: 999,
        risks: [`RugCheck API offline (${err.message || 'Timeout'}) - Veto preventivo`],
        isRugged: false,
        isSafe: false,
        verified: false,
        lpLockedPct: 0,
        topHoldersPct: 100
      };
    }
  }
}
