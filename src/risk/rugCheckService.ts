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

  // Riscos benignos normais do ecossistema Pump.fun / Raydium (não são honeypots fatais)
  private static readonly BENIGN_PUMPFUN_FLAGS = new Set<string>([
    'low amount of lp providers',
    'single lp provider',
    'mutable metadata',
    'high market cap per holder',
    'copycat token',
    'low liquidity'
  ]);

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

      const rawRisks = Array.isArray(data.risks) ? data.risks : [];
      const riskNames = rawRisks.map((r: any) => typeof r === 'string' ? r : (r.name || r.description || 'Risco não especificado'));

      // 1. Verificações Fatais Inegociáveis (Score = 0 / Veto Imediato)
      const isMintAuthActive = Boolean(data.token?.mintAuthority);
      const isFreezeAuthActive = Boolean(data.token?.freezeAuthority);
      const isRugged = Boolean(data.rugged) || isMintAuthActive || isFreezeAuthActive;

      // 2. Extração de métricas de LP trancada/queimada
      let lpLockedPct = 100;
      if (Array.isArray(data.markets)) {
        const raydiumMarket = data.markets.find((m: any) => m.lp);
        if (raydiumMarket?.lp) {
          const locked = Number(raydiumMarket.lp.lpLockedPct || raydiumMarket.lp.lpLocked || 0);
          const burned = Number(raydiumMarket.lp.lpBurnedPct || raydiumMarket.lp.lpBurned || 0);
          lpLockedPct = Math.max(locked, burned);
        }
      }

      // Se o RugCheck apontar "Large Amount of LP Unlocked", verifica se há queima de 100%
      const hasUnlockedLpRisk = rawRisks.some((r: any) => {
        const name = (typeof r === 'string' ? r : (r.name || '')).toLowerCase();
        return name.includes('large amount of lp unlocked');
      });

      if (hasUnlockedLpRisk && lpLockedPct < 90) {
        lpLockedPct = 0; // Confirma risco fatal de LP destrancada
      }

      // 3. Extração e Sanitização dos Top Holders (ignora AMM/Raydium Pool)
      let topHoldersPct = 0;
      if (Array.isArray(data.topHolders)) {
        const nonAmmHolders = data.topHolders.filter((h: any) => !h.isLpPool && !h.owner?.includes('Raydium') && !h.address?.includes('11111111111111111111111111111111'));
        topHoldersPct = nonAmmHolders.slice(0, 5).reduce((acc: number, h: any) => acc + Number(h.pct || 0), 0);
      }

      // 4. Avaliação de Riscos Fatais vs Penalidades Benignas
      let fatalRiskDetected = false;
      const fatalReasons: string[] = [];

      if (isMintAuthActive) {
        fatalRiskDetected = true;
        fatalReasons.push('Mint Authority Ativa');
      }
      if (isFreezeAuthActive) {
        fatalRiskDetected = true;
        fatalReasons.push('Freeze Authority Ativa');
      }
      if (Boolean(data.rugged)) {
        fatalRiskDetected = true;
        fatalReasons.push('Contrato Marcado como Rugged');
      }
      if (lpLockedPct < 90) {
        fatalRiskDetected = true;
        fatalReasons.push(`LP Trancada/Queimada insuficiente (${lpLockedPct.toFixed(1)}% < 90%)`);
      }
      if (topHoldersPct > 35) {
        fatalRiskDetected = true;
        fatalReasons.push(`Concentração excessiva de Top 5 Holders (${topHoldersPct.toFixed(1)}% > 35%)`);
      }

      // Checa se há algum risco com nível "danger" que não seja benigno
      for (const r of rawRisks) {
        const name = typeof r === 'string' ? r : (r.name || '');
        const level = typeof r === 'object' ? (r.level || '') : '';
        const lowerName = name.toLowerCase();

        if (level === 'danger' && !RugCheckService.BENIGN_PUMPFUN_FLAGS.has(lowerName)) {
          if (!lowerName.includes('low liquidity')) {
            fatalRiskDetected = true;
            fatalReasons.push(name);
          }
        }
      }

      const isSafe = !fatalRiskDetected;
      let finalScore = 80;

      if (!isSafe) {
        finalScore = 0;
      } else {
        // Aplica penalidades proporcionais leves para flags de aviso
        let penalty = 0;
        for (const r of rawRisks) {
          const name = (typeof r === 'string' ? r : (r.name || '')).toLowerCase();
          if (name.includes('mutable metadata')) penalty += 5;
          if (name.includes('high holder correlation')) penalty += 10;
        }
        finalScore = Math.max(50, 95 - penalty);
      }

      return {
        mint,
        score: finalScore,
        risks: fatalReasons.length > 0 ? fatalReasons : riskNames,
        isRugged: fatalRiskDetected,
        isSafe,
        verified: Boolean(data.verification?.verified),
        lpLockedPct,
        topHoldersPct
      };
    } catch (err: any) {
      // Fallback defensivo em caso de indisponibilidade da API
      return {
        mint,
        score: 0,
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
