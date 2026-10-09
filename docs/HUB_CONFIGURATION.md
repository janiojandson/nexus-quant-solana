# Hub configuration for the shadow integration

Runtime fails closed when credentials, mappings or quotas are absent. Never copy secrets between services. The runtime does not inspect project IDs, billing credits or grouping via getHealth.

## Helius (six global metadata entries; owner-local secrets)

Set HELIUS_CREDENTIALS to a JSON array of exactly six objects with id, apiKeyEnv, quotaGroupId, role and owner. apiKeyEnv names a variable, not its secret value. Set HELIUS_QUOTA_GROUPS to JSON allocations. The following is an illustrative allocation only; the operator must replace it with the verified ownership and project mapping. It is not a claim about existing keys.

```json
[
 {"id":"slot1","apiKeyEnv":"HELIUS_KEY_1","quotaGroupId":"UNKNOWN_SHARED","role":"CRITICAL","owner":"QUANT"},
 {"id":"slot2","apiKeyEnv":"HELIUS_KEY_2","quotaGroupId":"UNKNOWN_SHARED","role":"STATE","owner":"QUANT"},
 {"id":"slot3","apiKeyEnv":"HELIUS_KEY_3","quotaGroupId":"UNKNOWN_SHARED","role":"STATE","owner":"QUANT"},
 {"id":"slot4","apiKeyEnv":"HELIUS_KEY_4","quotaGroupId":"UNKNOWN_SHARED","role":"STATE","owner":"SENTINEL"},
 {"id":"slot5","apiKeyEnv":"HELIUS_KEY_5","quotaGroupId":"UNKNOWN_SHARED","role":"STATE","owner":"SENTINEL"},
 {"id":"slot6","apiKeyEnv":"HELIUS_KEY_6","quotaGroupId":"UNKNOWN_SHARED","role":"STATE","owner":"SENTINEL"}
]
```

```json
[{"id":"UNKNOWN_SHARED","quantRps":6,"sentinelRps":3}]
```

For this example Quant injects only HELIUS_KEY_1 through HELIUS_KEY_3; Sentinel injects only HELIUS_KEY_4 through HELIUS_KEY_6. Values are secret-manager supplied; no fake/default key is accepted. Both services use the same nonsecret manifest and allocation document. IDs and variable references must be globally distinct; secret values must be distinct within each service. Duplicate secret values across containers cannot be checked offline. Quant requires CRITICAL and STATE; Sentinel accepts STATE only. Membership never inferred from a key's order/name. Unknown grouping must explicitly use the single UNKNOWN_SHARED bucket (6+3 RPS, 1 RPS headroom); it cannot be mixed with independently claimed groups. Verified project IDs may replace it with explicit group allocations totaling at most 10 RPS per project. This is single-process admission: exactly one replica per service per allocation. Additional replicas/clients require reallocation or a shared coordinator before deployment. These local limits do not prove monthly credits or provider capacity.

Sentinel uses the first owned STATE key for the official Helius observer WebSocket. WebSocket limits/credits are independent and not validated by the HTTP budget. Quant subscriptions are disabled; its confirmation path polls signature statuses and block height via CRITICAL. Sentinel HTTP refuses blockhash, simulation, reconciliation and sends; isolated executor tests may inject a test Connection for unsigned simulation.

## Jupiter (Quant only)

Set JUPITER_ORG1_ID and JUPITER_ORG1_KEY through JUPITER_ORG4_ID and JUPITER_ORG4_KEY, without defaults. IDs/keys must be distinct. Org1 is PROTECTION, Org2/3 ENTRY, Org4 DISCOVERY. Organization IDs stay local and are never transmitted. HTTP uses only the fixed api.jup.ag host with x-api-key, GET /swap/v2/order and tokens/v2 query encoding, POST /swap/v2/execute JSON. No legacy API-key/URL or axios fallback. Priority 0/1 -> EXIT, 2/3 -> RECONCILE, 4/5 -> ENTRY. Priority 6 quote research is refused; standalone Quant strategy-lab quotes are disabled. Discovery uses token endpoints only. The legacy general coordinator does not delay hub traffic. Execute uncertainty is never retried; reconcile before another order.

Four 60-RPM buckets imply a theoretical 240 RPM total across roles, not verified capacity and not fungible between roles. Helius does not gain assumed independent project capacity merely by adding keys. Runtime reads env only; no actual credentials or billing state were inspected by this implementation.

## Migration

Replace HELIUS_API_KEYS/HELIUS_RPC_URL/QUICKNODE_RPC_URL/SOLANA_RPC_URL runtime selection with the manifest and owner-local key injection. Replace the single JUPITER_API_KEY with the four explicit organizations. Inject a hub-backed Connection into SolanaWalletService/JupiterExecutionEngine and Sentinel executor/watcher; legacy direct RPC creation now throws. Keep SHADOW_MODE/DRY_RUN_MODE safety from Task 1. No deployment or production config mutation is included. Out-of-band diagnostic scripts are outside runtime routing and must not be used as a fallback.
