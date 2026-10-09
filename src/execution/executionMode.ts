export interface ExecutionMode {
  shadow: boolean;
  canSign: boolean;
  canBroadcast: boolean;
}

export type ExecutionEnvironment = { SHADOW_MODE?: unknown; DRY_RUN_MODE?: unknown };

export function readSigningSecretKey(
  env: ExecutionEnvironment & { AGENT_SOLANA_PRIVATE_KEY?: string }
): string | undefined {
  return resolveExecutionMode(env).canSign ? env.AGENT_SOLANA_PRIVATE_KEY : undefined;
}

export function isHypotheticalExecution(result: {
  status?: string;
  isDryRun?: boolean;
  hypothetical?: boolean;
}): boolean {
  return result.hypothetical === true || result.isDryRun === true || result.status === 'DRY_RUN_SUCCESS';
}

export function resolveExecutionMode(env: ExecutionEnvironment = process.env): ExecutionMode {
  const shadowFlag = typeof env.SHADOW_MODE === 'string' ? env.SHADOW_MODE.trim().toLowerCase() : '';
  const dryFlag = typeof env.DRY_RUN_MODE === 'string' ? env.DRY_RUN_MODE.trim().toLowerCase() : '';
  const live = shadowFlag === 'false' && dryFlag === 'false';
  return { shadow: !live, canSign: live, canBroadcast: live };
}
