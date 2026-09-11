import { screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { HealthPage } from '../health';
import { status, T0 } from './fixtures';

describe('HealthPage', () => {
  it('shows the process counters as stats and charts above the raw status', async () => {
    vi.spyOn(api, 'getStatus').mockResolvedValue(status);
    vi.spyOn(api, 'getHealth').mockResolvedValue({
      started_at: T0,
      uptime_seconds: 125,
      open_ms: 42,
      recall: { count: 12, errors: 1, p50_ms: 3.2, p95_ms: 18, max_ms: 40 },
      ingest: { calls: 2, turns: 30 },
      series: [
        { minute: T0, recalls: 5, ingested: 30, errors: 0, p50_ms: 3, p95_ms: 10 },
        { minute: T0 + 60_000, recalls: 7, ingested: 0, errors: 1, p50_ms: 4, p95_ms: 18 },
      ],
    });
    renderPage(<HealthPage />, '/health');

    expect(await screen.findByText('Recall latency')).toBeInTheDocument();
    expect(screen.getByText('Throughput')).toBeInTheDocument();
    expect(screen.getByText('3.2 ms / 18 ms')).toBeInTheDocument();
    expect(screen.getByText(/12 recalls/)).toBeInTheDocument();
    expect(screen.getByText('42 ms')).toBeInTheDocument();
    expect(screen.getByText('Status payload')).toBeInTheDocument();
  });
});
