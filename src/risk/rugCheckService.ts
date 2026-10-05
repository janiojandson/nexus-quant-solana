import axios from 'axios';

export interface RugCheckReport {
  mint: string;
  score: number;
  risks: string[];
  isRugged: boolean;
  isSafe: boolean;
  verified: boolean;
  mintAuthority?: string | null;
  freezeAuthority?: string | null;
  holdersCount?: number;
  factsComplete?: boolean;
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
    'low liquidity',
    'large amount of lp unlocked',
    'top 10 holders high ownership',
    'single holder ownership',
    'high ownership'
  ]);

  constructor(options?: RugCheckOptions) {
    this.fetchClient = options?.fetchClient || (async (url: string) => axios.get(url, {
      timeout: 8000,
      headers: { 'Accept': 'application/json', 'User-Agent': 'NexusQuantSolana/1.0' }
    }));
  }

  public async auditToken(mint: string): Promise<RugCheckReport> {
    try {
      const url = `${RugCheckService.RUGCHECK_BASE_URL}/${mint}/report`;
      const response = await this.fetchClient(url);
      const data = response.data || {};

      const rawRisks = Array.isArray(data.risks) ? data.risks : [];
      const riskNames = rawRisks.map((r: any) => typeof r === 'string' ? r : (r.name || r.description || 'Risco não especificado'));

      const tokenData = data.token && typeof data.token === 'object' ? data.token : {};
      const hasOwn = (obj: any, key: string) => Object.prototype.hasOwnProperty.call(obj || {}, key);
      const mintAuthority = hasOwn(tokenData, 'mintAuthority') ? tokenData.mintAuthority : data.mintAuthority;
      const freezeAuthority = hasOwn(tokenData, 'freezeAuthority') ? tokenData.freezeAuthority : data.freezeAuthority;
      const validAuthority = (value: unknown) => value === null || (typeof value === 'string' && value.length > 0);
      const mintAuthorityKnown = validAuthority(mintAuthority);
      const freezeAuthorityKnown = validAuthority(freezeAuthority);
      const holdersRaw = data.totalHolders == null ? NaN : Number(data.totalHolders);
      const holdersCount = Number.isFinite(holdersRaw) && holdersRaw >= 0 ? holdersRaw : undefined;

      // 1. Verificações fatais inequívocas. Campo ausente nunca significa autoridade revogada.
      const isMintAuthActive = mintAuthorityKnown && Boolean(mintAuthority);
      const isFreezeAuthActive = freezeAuthorityKnown && Boolean(freezeAuthority);
      const isRugged = Boolean(data.rugged) || isMintAuthActive || isFreezeAuthActive;

      // 2. Extração de métricas de LP trancada/queimada. Ausência permanece UNKNOWN.
      const directLp = data.lpLockedPct == null ? NaN : Number(data.lpLockedPct);
      let lpLockedPct: number | undefined = Number.isFinite(directLp) && directLp >= 0 && directLp <= 100 ? directLp : undefined;
      const isPumpFun = mint.toLowerCase().endsWith('pump') ||
        (Array.isArray(data.markets) && data.markets.some((m: any) => m.marketType === 'pump_fun_amm'));

      if (Array.isArray(data.markets)) {
        const raydiumMarket = data.markets.find((m: any) => m.lp);
        if (raydiumMarket?.lp) {
          const locked = Number(raydiumMarket.lp.lpLockedPct ?? raydiumMarket.lp.lpLocked ?? NaN);
          const burned = Number(raydiumMarket.lp.lpBurnedPct ?? raydiumMarket.lp.lpBurned ?? NaN);
          const candidates = [locked, burned].filter(value => Number.isFinite(value) && value >= 0 && value <= 100);
          if (candidates.length > 0) lpLockedPct = Math.max(...candidates);
        }
      }

      // Em tokens na curva do Pump.fun, a liquidez fica 100% sob custódia do contrato imutável (impossível rugpull)
      if (isPumpFun && (lpLockedPct === undefined || lpLockedPct === 0)) {
        lpLockedPct = 100;
      }

      // Top five measured holder percentages. Missing or invalid facts remain unknown.
      let topHoldersPct: number | undefined;
      if (Array.isArray(data.topHolders) && data.topHolders.length > 0) {
        const nonAmmHolders = data.topHolders.filter((h: any) => {
          if (h.isLpPool) return false;
          const owner = String(h.owner || '').toLowerCase();
          const address = String(h.address || '').toLowerCase();
          if (owner.includes('raydium') || address.includes('11111111111111111111111111111111')) return false;
          // Ignora a conta da Bonding Curve PDA / Programa Pump.fun (reserva do protocolo, não baleia humana)
          if (owner.includes('6ef8rrecthr5dkzon8nwu78hrvfckubj14m5ubewf6p') || owner.includes('pump') || address.endsWith('pump')) return false;
          return true;
        });
        const percentages = nonAmmHolders.map((h: any) => h.pct == null ? NaN : Number(h.pct));
        if (percentages.every((pct: number) => Number.isFinite(pct) && pct >= 0 && pct <= 100)) {
          const sum = percentages.sort((a: number, b: number) => b - a).slice(0, 5).reduce((acc: number, pct: number) => acc + pct, 0);
          if (sum <= 100) topHoldersPct = sum;
        }
      }

      const missingFacts: string[] = [];
      if (!mintAuthorityKnown) missingFacts.push('mintAuthority');
      if (!freezeAuthorityKnown) missingFacts.push('freezeAuthority');
      if (holdersCount === undefined) missingFacts.push('totalHolders');
      if (lpLockedPct === undefined) missingFacts.push('lpLockedPct');
      if (topHoldersPct === undefined) missingFacts.push('topHolders');
      const factsComplete = missingFacts.length === 0;

      // 4. Avaliação de riscos fatais vs penalidades benignas.
      let fatalRiskDetected = !factsComplete;
      const fatalReasons: string[] = [];
      if (!factsComplete) {
        fatalReasons.push(`RugCheck sem fatos críticos: ${missingFacts.join(', ')}`);
      }
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
      if (lpLockedPct !== undefined && lpLockedPct < 90) {
        fatalRiskDetected = true;
        fatalReasons.push(`LP Trancada/Queimada insuficiente (${lpLockedPct.toFixed(1)}% < 90%)`);
      }
      if (topHoldersPct !== undefined && topHoldersPct > 35) {
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
        isRugged,
        isSafe,
        verified: Boolean(data.verification?.verified),
        mintAuthority: mintAuthorityKnown ? (mintAuthority ?? null) : undefined,
        freezeAuthority: freezeAuthorityKnown ? (freezeAuthority ?? null) : undefined,
        holdersCount,
        factsComplete,
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
        factsComplete: false,
        lpLockedPct: undefined,
        topHoldersPct: undefined
      };
    }
  }
}
