import {JupiterOrgHub} from './jupiterOrgHub.js';
import {HeliusRpcHub} from './heliusRpcHub.js';
import {createJupiterTransport,createHeliusTransport} from './transports.js';
import {loadJupiterCredentials,loadHeliusConfiguration} from './hubConfiguration.js';
import {createHubConnection} from './hubConnection.js';
import {resolveExecutionMode} from '../execution/executionMode.js';
export const hubRuntime={now:Date.now,sleep:async(ms:number)=>{await new Promise<void>(r=>setTimeout(r,ms));},random:Math.random};
export function createQuantHubs(env:NodeJS.ProcessEnv=process.env,fetcher:typeof fetch=fetch){
 const config=loadHeliusConfiguration(env,'QUANT');
 const rpcHub=new HeliusRpcHub(config.keys,config.groups,createHeliusTransport(fetcher),hubRuntime,{allowedRoles:config.allowedRoles});
 const jupiterHub=new JupiterOrgHub(loadJupiterCredentials(env),createJupiterTransport(fetcher),hubRuntime);
 const connection=createHubConnection(rpcHub,{canBroadcast:()=>resolveExecutionMode(env).canBroadcast});
 return {rpcHub,jupiterHub,connection};
}
