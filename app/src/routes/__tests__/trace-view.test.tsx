import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TraceView } from '@/components/memory/trace-view';
import { trace } from './fixtures';

describe('TraceView', () => {
  it('shows every stage of the pipeline with the dropped candidate and its reason', () => {
    render(<TraceView trace={trace} />);

    expect(screen.getByText('1 · Profile')).toBeInTheDocument();
    expect(screen.getByText('2 · Views (2 routed)')).toBeInTheDocument();
    expect(screen.getByText('3 · Fused (2)')).toBeInTheDocument();
    expect(screen.getByText('4 · Evidence (1) · 3 ms')).toBeInTheDocument();
    expect(screen.getByText('owns')).toBeInTheDocument();
    expect(screen.getByText(/below the calibrated floor/)).toBeInTheDocument();
    expect(screen.getByText('Maya Okafor owns billing.')).toBeInTheDocument();
  });
});
