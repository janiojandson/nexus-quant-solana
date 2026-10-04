-- Migration 004: Multi-leg Fill Identity on Position Mutations (Finding 28 & 29, V2.3-R3)

ALTER TABLE nexus_position_mutations_v2
ADD COLUMN IF NOT EXISTS chain_leg_index INTEGER NOT NULL DEFAULT 0,
ADD COLUMN IF NOT EXISTS instruction_index INTEGER NOT NULL DEFAULT -1,
ADD COLUMN IF NOT EXISTS inner_instruction_index INTEGER NOT NULL DEFAULT -1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_mutation_onchain_leg
ON nexus_position_mutations_v2 (position_id, signature, chain_leg_index, instruction_index, inner_instruction_index)
WHERE signature IS NOT NULL AND mutation_type IN ('PARTIAL_FILL', 'FINAL_FILL');
