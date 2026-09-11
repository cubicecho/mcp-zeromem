import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import * as api from '@/lib/api';
import { renderPage } from '@/test-support';
import { GraphExplorer } from '../graph';
import { T0 } from './fixtures';

describe('GraphExplorer', () => {
  it('lists the snapshot as a table twin and focuses an entity from the form', async () => {
    const getGraph = vi.spyOn(api, 'getGraph').mockResolvedValue({
      nodes: [
        { entity: 'maya okafor', kind: 'name', turns: 5, degree: 2, first_ts: T0, last_ts: T0 + 1000 },
        { entity: 'heron', kind: 'name', turns: 3, degree: 1, first_ts: T0, last_ts: T0 },
        { entity: '2024-05-01', kind: 'date', turns: 1, degree: 1, first_ts: T0, last_ts: T0 },
      ],
      edges: [
        { a: 'maya okafor', b: 'heron', turns: 3 },
        { a: 'maya okafor', b: '2024-05-01', turns: 1 },
      ],
      total_entities: 40,
      total_edges: 90,
      truncated: true,
      generation: 1,
    });
    const onChange = vi.fn();
    renderPage(<GraphExplorer options={{}} onChange={onChange} />, '/graph');

    expect(await screen.findByText('Most connected entities')).toBeInTheDocument();
    expect(screen.getByText(/3 of 40 entities/)).toBeInTheDocument();
    expect(getGraph).toHaveBeenCalledWith({});

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /table/i }));
    expect(await screen.findByRole('cell', { name: 'maya okafor' })).toBeInTheDocument();

    await user.type(screen.getByLabelText('Focus entity'), 'heron');
    await user.click(screen.getByRole('button', { name: 'Focus' }));
    expect(onChange).toHaveBeenCalledWith(expect.objectContaining({ focus: 'heron' }));
  });
});
