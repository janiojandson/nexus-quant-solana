import { JupiterOrgHub } from "../hubs/jupiterOrgHub.js";
import { HeliusRpcHub } from "../hubs/heliusRpcHub.js";

const SLEEP_MS = 500;
const SOL_MINT = "So11111111111111111111111111111111111111112";

export class PreFlightEngine {
  constructor(
    private jupiterHub: JupiterOrgHub, 
    private rpcHub: HeliusRpcHub,
    private readonly walletPublicKey: string
  ) {}

  async executeShadowCycle(mint: string) {
    let consistentSamples = 0;

    for (let i = 0; i < 4; i++) {
      // Isolamento de Org 1 (PROTECTION): Usa estritamente 'ENTRY' (Org 2/3)
      const quoteRes = await this.jupiterHub.request('ENTRY', '/swap/v2/order', {
        inputMint: SOL_MINT,
        outputMint: mint,
        amount: "100000000" // 0.1 SOL
      });
      
      if (quoteRes.status === 200) {
        const quote = quoteRes.body as any;
        const outAmount = quote.outAmount;
        
        const reverseRes = await this.jupiterHub.request('ENTRY', '/swap/v2/order', {
          inputMint: mint,
          outputMint: SOL_MINT,
          amount: outAmount
        });

        if (reverseRes.status === 200) {
           const slippage = this.calculateSpread(quote, reverseRes.body);
           if (slippage <= 0.05) consistentSamples++;
        }
      }
      
      await new Promise(r => setTimeout(r, SLEEP_MS));
    }

    if (consistentSamples >= 3) {
      await this.fireUnsignedShadowTransaction(mint);
    }
  }

  private calculateSpread(forward: any, reverse: any): number {
    const inSol = 100000000;
    const finalSol = Number(reverse.outAmount || 0);
    return finalSol > 0 ? (inSol - finalSol) / inSol : 1;
  }

  private async fireUnsignedShadowTransaction(mint: string) {
    // Pede a transação montada usando a PUBLIC KEY real
    const txResponse = await this.jupiterHub.request('ENTRY', '/swap/v2/order', {
      userPublicKey: this.walletPublicKey,
      wrapAndUnwrapSol: true,
      inputMint: SOL_MINT,
      outputMint: mint,
      amount: "100000000"
    });

    if (txResponse.status !== 200) return;
    const txData = txResponse.body as any;

    // Simula via HeliusRpcHub usando apenas a role CRITICAL
    // sigVerify false, garantindo execução ZERO signature
    const simResult = await this.rpcHub.call('CRITICAL', 'simulateTransaction', [
      txData.swapTransaction,
      { sigVerify: false, commitment: "processed" }
    ]);

    console.log(`[SHADOW PRE-FLIGHT] Simulação processada para ${mint}:`, (simResult as any).body);
  }
}
