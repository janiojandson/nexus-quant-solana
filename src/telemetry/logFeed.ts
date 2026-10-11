/**
 * Ring buffer de telemetria em memória para o painel "Telemetria & Logs".
 * Espelha cada entrada no console (stdout do Railway) e mantém os últimos
 * MAX_ENTRIES registros para o /api/status.
 */
export type LogFeedType = 'info' | 'warn' | 'success' | 'fallback';

export interface LogFeedEntry {
  timestamp: string;
  message: string;
  type: LogFeedType;
}

const MAX_ENTRIES = 200;
const entries: LogFeedEntry[] = [];

export function logFeed(type: LogFeedType, message: string): void {
  entries.push({ timestamp: new Date().toISOString(), message, type });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  // Mantém visibilidade nos logs do Railway sem duplicar no painel.
  if (type === 'warn') console.warn(message);
  else console.log(message);
}

export function getLogFeedEntries(): LogFeedEntry[] {
  return entries.slice();
}
