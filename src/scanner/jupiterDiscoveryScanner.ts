import { JupiterOrgHub } from "../hubs/jupiterOrgHub.js";

export class JupiterDiscoveryScanner {
  constructor(private jupiterHub: JupiterOrgHub) {}

  async scanTrendingTokens(): Promise<string[]> {
    const response = await this.jupiterHub.request('DISCOVERY', '/tokens/v2/toptrending/5m');
    if (response.status !== 200) return [];
    
    const data = response.body as { tokens?: { address: string }[] };
    return (data.tokens || []).map((t: any) => t.address);
  }
}
