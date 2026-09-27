export interface AgentReachConfig {
  officialWalletAddress: string;
  sessionCookie?: string;
}

export interface PublishPostParams {
  platform: 'X' | 'INSTAGRAM';
  content: string;
  mediaUrl?: string;
}

export interface PublishPostResult {
  success: boolean;
  postId?: string;
  platform: string;
  publishedAt: string;
}

export interface AlphaPostData {
  tokenSymbol: string;
  mintAddress: string;
  narrative: string;
  targetGainX: string;
}

export class AgentReachClient {
  private officialWalletAddress: string;

  constructor(config: AgentReachConfig) {
    this.officialWalletAddress = config.officialWalletAddress;
  }

  public formatAlphaPost(data: AlphaPostData): string {
    return [
      `🚨 [ALERTA ALPHA SOLANA] $${data.tokenSymbol}`,
      `📊 Tese: ${data.narrative}`,
      `🎯 Alvo Estimado: ${data.targetGainX}`,
      `🪙 CA: ${data.mintAddress}`,
      ``,
      `☕ Apoie nosso agente autônomo (Tips em SOL):`,
      `${this.officialWalletAddress}`,
      `#Solana #Memecoin #Crypto #PumpFun`
    ].join('\n');
  }

  public sanitizePostContent(content: string, platform: 'X' | 'INSTAGRAM'): string {
    const limit = platform === 'X' ? 280 : 2200;
    if (content.length <= limit) {
      return content;
    }
    return content.slice(0, limit - 3) + '...';
  }

  public async publishPost(params: PublishPostParams): Promise<PublishPostResult> {
    const sanitized = this.sanitizePostContent(params.content, params.platform);

    // Simulação ou conexão real com o daemon local agent-reach
    const mockPostId = `${params.platform.toLowerCase()}_${Date.now()}`;

    return {
      success: true,
      postId: mockPostId,
      platform: params.platform,
      publishedAt: new Date().toISOString()
    };
  }
}
