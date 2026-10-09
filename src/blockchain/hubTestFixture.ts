// Test fixtures only; never imported by runtime modules.
import {JupiterOrgHub} from '../hubs/jupiterOrgHub.js';
export function hubFixture(){
 const transport:{get:(...args:any[])=>Promise<any>;post:(...args:any[])=>Promise<any>}={get:async()=>{throw Error('Unexpected test GET');},post:async()=>{throw Error('Unexpected test POST');}};
 const hub=new JupiterOrgHub(['PROTECTION','ENTRY','ENTRY','DISCOVERY'].map((role,i)=>({orgId:`fixture-${i}`,apiKey:i===0?'test-key':`test-key-${i}`,role:role as any})),async (credential,endpoint,payload)=>{
  try {const res=endpoint.endsWith('/execute')?await transport.post('https://fake.invalid/execute',payload):await transport.get('https://fake.invalid/order',{params:payload,headers:{'x-api-key':'test-key'}});
   return {status:200,headers:new Headers(),body:res.data};
  }catch(e:any){if(e.response)return {status:e.response.status,headers:new Headers(e.response.headers),body:e.response.data};throw e;}
 },{now:Date.now,sleep:async(ms)=>{await new Promise(r=>setTimeout(r,ms));}});
 return {hub,transport};
}
