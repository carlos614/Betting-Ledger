/**
 * Log estruturado (uma linha JSON por evento). Campos de correlação: correlationId, messageId,
 * transactionId, walletId, providerId. Regra: NUNCA logar payloads financeiros completos nem valores.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [extra: string]: unknown;
}

const SENSITIVE = /^(money|amount|balance|payload|authorization|token|password)$/i;

export function logEvent(level: LogLevel, msg: string, fields: LogFields = {}): void {
  if (process.env.LOG_SILENT === 'true') return;
  const safe: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) if (!SENSITIVE.test(k)) safe[k] = v;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...safe });
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(`${line}\n`);
}
