import axios from 'axios';

export interface TelegramNotificationParams {
  title: string;
  symbol: string;
  mint: string;
  action: string;
  pnlPct?: number;
  solValue?: number;
  txSignature?: string;
  detail?: string;
}

export class CerebroIntegrationService {
  private cerebroUrl: string;
  private botToken?: string;
  private chatId?: string;

  constructor() {
    this.cerebroUrl = process.env.NEXUS_CEREBRO_URL || process.env.NEXUS_CEREBRO_INTERNAL_URL || 'http://localhost:3000';
    this.botToken = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID_OPERACIONAL || process.env.TELEGRAM_CHAT_ID_EXECUTIVO;
  }

  /**
   * Envia notificação executiva e operacional diretamente via Telegram (ou via Cérebro como relay)
   */
  public async notifyTradeEvent(params: TelegramNotificationParams): Promise<boolean> {
    const pnlText = params.pnlPct !== undefined 
      ? `\n📈 <b>PnL:</b> ${params.pnlPct >= 0 ? '+' : ''}${(params.pnlPct * 100).toFixed(2)}%`
      : '';
    const solText = params.solValue !== undefined 
      ? `\n🪙 <b>Valor:</b> ${params.solValue.toFixed(4)} SOL`
      : '';
    const detailText = params.detail ? `\n🧠 <b>Sentinela:</b> ${params.detail}` : '';
    const txLink = params.txSignature 
      ? `\n🔗 <a href="https://solscan.io/tx/${params.txSignature}">Ver no Solscan</a>`
      : '';

    const message = `🚀 <b>[NEXUS QUANT SOLANA]</b> — ${params.title}\n` +
      `🪙 <b>Ativo:</b> ${params.symbol} (<code>${params.mint.slice(0, 6)}...${params.mint.slice(-4)}</code>)\n` +
      `⚡ <b>Ação:</b> ${params.action}` +
      pnlText + solText + detailText + txLink;

    // 1. Envio Direto via Telegram Bot API se as credenciais estiverem configuradas
    if (this.botToken && this.chatId) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${this.botToken}/sendMessage`,
          {
            chat_id: this.chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          },
          { timeout: 4000 }
        );
        return true;
      } catch (err: any) {
        console.warn(`⚠️ [Telegram Direct] Falha ao enviar alerta:`, err?.message || err);
      }
    }

    // 2. Notificação de Emergência via WhatsApp (Comunicacao Hub) caso seja sinalizado como urgente ou Stop crítico
    if (params.pnlPct !== undefined && params.pnlPct <= -0.15) {
      this.sendEmergencyWhatsApp(
        `🚨 *[ALERTA MÁXIMO SOLANA]*\nAtivo: ${params.symbol}\nMotivo: ${params.title}\nPnL: ${(params.pnlPct * 100).toFixed(2)}%\n${params.detail || ''}`
      ).catch(() => {});
    }

    // 3. Fallback via Hub do Cérebro
    try {
      await axios.post(
        `${this.cerebroUrl}/v1/comunicacao/notificar`,
        {
          canal: 'telegram',
          mensagem: message,
          contexto: 'SOLANA_TRADE_EVENT'
        },
        { timeout: 3000 }
      );
      return true;
    } catch {
      // Falha silenciosa para não bloquear o motor de execução rápida
      return false;
    }
  }

  /**
   * Dispara mensagem de emergência via WhatsApp conectando diretamente ao Comunicacao Hub (Railway ou Nuvem)
   */
  public async sendEmergencyWhatsApp(texto: string): Promise<boolean> {
    const hubUrl = (process.env.COMUNICACAO_API_URL || 'https://comunicacao-hub-production.up.railway.app').replace(/\/api\/?$/, '').replace(/\/$/, '');
    const hubKey = process.env.COMUNICACAO_API_KEY || 'nexus_secret_hub_2026_x89a';
    const instance = process.env.COMUNICACAO_INSTANCE || 'financas';
    const targetRecipient = process.env.WHATSAPP_ADMIN_NUMBER || process.env.WHATSAPP_EMERGENCY_GROUP || '5521977440606';

    try {
      await axios.post(
        `${hubUrl}/api/v1/${instance}/send-text`,
        {
          to: targetRecipient,
          message: texto,
          simulateTyping: false,
          priority: 'high'
        },
        {
          headers: {
            'x-api-key': hubKey,
            'Authorization': `Bearer ${hubKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 8000
        }
      );
      return true;
    } catch (err: any) {
      console.warn('⚠️ [WhatsApp Alerta] Falha ao enviar via Comunicacao Hub:', err?.response?.data || err?.message || err);
      return false;
    }
  }

  /**
   * Envia o Morning Briefing diário com telemetria quantitativa factual
   */
  public async notifyMorningBriefing(briefing: {
    totalTrades: number;
    totalDecisions: number;
    winRate: number;
    overallEV: number;
    rugVetoesCount: number;
    walletBalanceSol?: number;
    warnings: string[];
  }): Promise<boolean> {
    const lines = [
      `🌅 <b>[NEXUS QUANT SOLANA] — MORNING BRIEFING DIÁRIO</b>`,
      `📅 <b>Data (UTC):</b> ${new Date().toISOString().slice(0, 10)}`,
      `💰 <b>Saldo Carteira:</b> ${briefing.walletBalanceSol !== undefined ? `${briefing.walletBalanceSol.toFixed(4)} SOL` : 'N/A'}`,
      ``,
      `📊 <b>Telemetria de Operação:</b>`,
      `• Decisões Avaliadas: <b>${briefing.totalDecisions}</b>`,
      `• Trades Executados: <b>${briefing.totalTrades}</b>`,
      `• Win Rate: <b>${(briefing.winRate * 100).toFixed(1)}%</b>`,
      `• Expectância Líquida (EV): <b>${briefing.overallEV >= 0 ? '+' : ''}${briefing.overallEV.toFixed(2)}%</b>`,
      `• Vetos Anti-Rug (RugCheck): <b>${briefing.rugVetoesCount} defesas de capital</b>`,
    ];

    if (briefing.warnings.length > 0) {
      lines.push(``, `⚠️ <b>Avisos da Calibração:</b>`);
      briefing.warnings.forEach(w => lines.push(`• ${w}`));
    }

    lines.push(``, `🔒 <i>Relatório factual gerado pelo cron de calibração. Motor em operação segura.</i>`);

    const message = lines.join('\n');

    if (this.botToken && this.chatId) {
      try {
        await axios.post(
          `https://api.telegram.org/bot${this.botToken}/sendMessage`,
          {
            chat_id: this.chatId,
            text: message,
            parse_mode: 'HTML',
            disable_web_page_preview: true
          },
          { timeout: 5000 }
        );
        return true;
      } catch (err: any) {
        console.warn(`⚠️ [Telegram Direct] Falha ao enviar morning briefing:`, err?.message || err);
      }
    }

    try {
      await axios.post(
        `${this.cerebroUrl}/v1/comunicacao/notificar`,
        {
          canal: 'telegram',
          mensagem: message,
          contexto: 'SOLANA_MORNING_BRIEFING'
        },
        { timeout: 3000 }
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Consulta o Cérebro / OmniRoute para análise LLM sob demanda
   */
  public async askOmniRoute(prompt: string): Promise<string | null> {
    try {
      const res = await axios.post(
        `${this.cerebroUrl}/v1/chat/completions`,
        {
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.1
        },
        { timeout: 5000 }
      );
      return res.data?.choices?.[0]?.message?.content || null;
    } catch {
      return null;
    }
  }
}

