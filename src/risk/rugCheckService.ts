import axios from 'axios';

export interface RugCheckReport {
  mint: string;
  score: number;
  risks: string[];
  isRugged: boolean;
  isSafe: boolean;
  verified: boolean;
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

      // Token seguro apenas se score < 500 e não for rugged
      const isSafe = !isRugged && score < RugCheckService.DANGER_SCORE_THRESHOLD;

      return {
        mint,
        score,
        risks: riskNames,
        isRugged,
        isSafe,
        verified: Boolean(data.verification?.verified)
      };
    } catch (err: any) {
      // Fallback em caso de timeout de rede: proteção defensiva
      return {
        mint,
        score: 999,
        risks: [`RugCheck API offline (${err.message || 'Timeout'}) - Veto preventivo`],
        isRugged: false,
        isSafe: false,
        verified: false
      };
    }
  }
}
