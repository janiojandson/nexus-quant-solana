import type { JupiterTransport } from './jupiterOrgHub.js';
import type { RpcTransport } from './heliusRpcHub.js';

/** Errors are categorical: never retain provider text, URLs, headers or causes. */
async function body(response: Response): Promise<unknown> {
  const text = await response.text();
  try { return JSON.parse(text); }
  catch { return /max usage reached|credits? exhausted/i.test(text) ? 'max usage reached' : 'non-JSON provider response'; }
}

export function createJupiterTransport(fetcher: typeof fetch = fetch): JupiterTransport {
  return async (credential, endpoint, payload, signal) => {
    const execute = endpoint === '/swap/v2/execute';
    if (execute && (!payload || typeof payload!=='object' || Object.keys(payload).some(key=>!['signedTransaction','requestId','lastValidBlockHeight'].includes(key)))) throw new Error('Invalid Jupiter execute payload');
    if (!execute && endpoint !== '/swap/v2/order' && !/^\/tokens\/v2\/(recent|search|(?:toporganicscore|toptraded|toptrending)\/(?:5m|1h|6h|24h))$/.test(endpoint)) throw new Error('Invalid Jupiter endpoint');
    const url = new URL(endpoint, 'https://api.jup.ag');
    if (!execute && payload) for (const [key, value] of Object.entries(payload)) {
      if (key === 'orgId' || !['string','number','boolean'].includes(typeof value)) throw new Error('Invalid Jupiter query');
      url.searchParams.set(key, String(value));
    }
    const response = await fetcher(url.toString(), {redirect:'error',method:execute ? 'POST':'GET',
      headers:execute ? {'x-api-key':credential.apiKey,'Content-Type':'application/json'} : {'x-api-key':credential.apiKey},
      ...(execute ? {body:JSON.stringify(payload)} : {}), ...(signal ? {signal} : {})});
    return {status:response.status,headers:response.headers,body:await body(response)};
  };
}

export function createHeliusTransport(fetcher: typeof fetch = fetch): RpcTransport {
  let id=0;
  return async (key, method, params, signal) => {
    const url=new URL('https://mainnet.helius-rpc.com/'); url.searchParams.set('api-key',key.apiKey);
    const response=await fetcher(url.toString(), {redirect:'error',method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params}),signal});
    return {status:response.status,headers:response.headers,body:await body(response)};
  };
}
