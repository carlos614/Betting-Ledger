/**
 * Métricas no formato texto do Prometheus (sem dependências). Instrumentação mínima exigida:
 *  wager_transactions_total{status,kind}   transações por status
 *  wager_duplicates_total{source}          duplicatas detectadas (replay HTTP / mensagem duplicada / idempotência)
 *  wager_retries_total{reason}             retries (SQS e publicação do outbox)
 *  wager_dlq_messages_total{reason}        mensagens enviadas à DLQ
 *  wager_lock_conflicts_total{type}        deadlock / lock timeout / violação de unicidade concorrente
 *  wager_outbox_lag_seconds                idade do evento pendente mais antigo
 *  wager_processing_duration_seconds       histograma da latência de processamento
 *  wager_reconciliation_divergences_total  saldo ≠ razão
 */
type Labels = Record<string, string>;

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

const key = (labels: Labels): string =>
  Object.keys(labels)
    .sort()
    .map((k) => `${k}="${String(labels[k]).replace(/["\\\n]/g, '_')}"`)
    .join(',');

export class MetricsService {
  private readonly counters = new Map<string, Map<string, number>>();
  private readonly gauges = new Map<string, number>();
  private readonly histograms = new Map<string, { counts: number[]; sum: number; count: number }>();

  inc(name: string, labels: Labels = {}, by = 1): void {
    const series = this.counters.get(name) ?? new Map<string, number>();
    const k = key(labels);
    series.set(k, (series.get(k) ?? 0) + by);
    this.counters.set(name, series);
  }

  setGauge(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  observe(name: string, seconds: number): void {
    const h = this.histograms.get(name) ?? { counts: BUCKETS.map(() => 0), sum: 0, count: 0 };
    BUCKETS.forEach((b, i) => {
      if (seconds <= b) h.counts[i] = (h.counts[i] ?? 0) + 1;
    });
    h.sum += seconds;
    h.count += 1;
    this.histograms.set(name, h);
  }

  /** valor atual de um contador (para testes) */
  counter(name: string, labels: Labels = {}): number {
    return this.counters.get(name)?.get(key(labels)) ?? 0;
  }

  render(): string {
    const lines: string[] = [];
    for (const [name, series] of this.counters) {
      lines.push(`# TYPE ${name} counter`);
      for (const [k, v] of series) lines.push(`${name}${k ? `{${k}}` : ''} ${v}`);
    }
    for (const [name, v] of this.gauges) {
      lines.push(`# TYPE ${name} gauge`, `${name} ${v}`);
    }
    for (const [name, h] of this.histograms) {
      lines.push(`# TYPE ${name} histogram`);
      BUCKETS.forEach((b, i) => lines.push(`${name}_bucket{le="${b}"} ${h.counts[i] ?? 0}`));
      lines.push(`${name}_bucket{le="+Inf"} ${h.count}`, `${name}_sum ${h.sum}`, `${name}_count ${h.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
