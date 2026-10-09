import { Connection, type ConnectionConfig } from '@solana/web3.js';
import { criticalRpcMethods, type HeliusRpcHub } from './heliusRpcHub.js';

export interface HubConnectionPolicy { canBroadcast(): boolean; stateOnly?: boolean; observerWsEndpoint?: string }

/** Every HTTP request is decoded locally; the endpoint is only a web3 label. */
export function createHubConnection(hub: Pick<HeliusRpcHub,'call'>, policy: HubConnectionPolicy): Connection {
  const adapter: NonNullable<ConnectionConfig['fetch']> = async (_url, init) => {
    let request: {id:unknown;jsonrpc:string;method:string;params:unknown[]};
    try { request=JSON.parse(String(init?.body)); } catch { throw new Error('Invalid RPC envelope'); }
    if (request.jsonrpc!=='2.0' || typeof request.method!=='string' || !Array.isArray(request.params)) throw new Error('Invalid RPC envelope');
    const critical=criticalRpcMethods.has(request.method);
    if (critical && policy.stateOnly) throw new Error('CRITICAL RPC forbidden for observer role');
    if (request.method==='sendTransaction' && !policy.canBroadcast()) throw new Error('Execution policy blocks broadcast');
    const result=await hub.call(critical ? 'CRITICAL':'STATE',request.method,request.params,
      init?.signal ? {signal:init.signal} : {});
    return new Response(JSON.stringify({jsonrpc:'2.0',id:request.id,result}), {status:200,headers:{'Content-Type':'application/json'}});
  };
  const connection=new Connection('https://mainnet.helius-rpc.com/', {commitment:'confirmed',fetch:adapter,disableRetryOnRateLimit:true,
    ...(policy.observerWsEndpoint ? {wsEndpoint:policy.observerWsEndpoint} : {})});
  const subscriptions=new Set(['onAccountChange','onProgramAccountChange','onLogs','onSignature','onSignatureWithOptions','onSlotChange','onSlotUpdate','onRootChange']);
  return new Proxy(connection,{get(target,prop){
    if (typeof prop==='string' && subscriptions.has(prop) && !policy.observerWsEndpoint) return () => {throw new Error('Unmanaged RPC subscriptions disabled');};
    // web3 confirmation implicitly subscribes; poll through the hub instead.
    if (prop==='confirmTransaction') return async (strategy: string | {signature:string;lastValidBlockHeight?:number;abortSignal?:AbortSignal}) => {
      if(policy.stateOnly) throw new Error('CRITICAL RPC forbidden for observer role');
      const signature=typeof strategy==='string' ? strategy : strategy.signature;
      const deadline=Date.now()+30000;
      while(Date.now()<deadline){
        if(typeof strategy!=='string' && strategy.abortSignal?.aborted) throw new Error('Confirmation aborted');
        const result=await target.getSignatureStatuses([signature],{searchTransactionHistory:true});
        const status=result.value[0];
        if(status && (status.err || status.confirmationStatus==='confirmed' || status.confirmationStatus==='finalized')) return {context:result.context,value:{err:status.err}};
        if(typeof strategy!=='string' && strategy.lastValidBlockHeight!==undefined && await target.getBlockHeight('confirmed')>strategy.lastValidBlockHeight) throw new Error('Transaction confirmation expired');
        await new Promise(resolve=>setTimeout(resolve,1000));
      }
      throw new Error('Transaction confirmation unknown; reconcile before retry');
    };
    const value=Reflect.get(target,prop,target); return typeof value==='function' ? value.bind(target) : value;
  }});
}
