// src/config/env.ts — Configurações Padronizadas do Nexus Quant Solana
import dotenv from 'dotenv';
dotenv.config();

/**
 * Stake de entrada equalizado para 0.025 SOL (~2% da banca operacional).
 */
export const BUY_AMOUNT_SOL = 0.025;

/**
 * Quantidade exata em lamports para swaps da Jupiter v6 (25.000.000 lamports).
 */
export const BUY_AMOUNT_LAMPORTS = 25_000_000;

/**
 * Slippage máximo padrão para entrada (750 bps = 7.5%).
 */
export const DEFAULT_ENTRY_SLIPPAGE_BPS = 750;

/**
 * Slippage para saída segura (500 bps = 5.0%).
 */
export const DEFAULT_EXIT_SLIPPAGE_BPS = 500;

/**
 * Stop Loss fixo inicial (-12.5%).
 */
export const INITIAL_STOP_LOSS_PCT = -0.125;

/**
 * Limite de posições simultâneas sob gestão.
 */
export const MAX_CONCURRENT_POSITIONS = 2;
