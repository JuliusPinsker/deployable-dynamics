import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import SimulationPage from '@/pages/SimulationPage';

const { cubeSatViewerPropsSpy } = vi.hoisted(() => ({
  cubeSatViewerPropsSpy: vi.fn(),
}));

vi.mock('@/components/CubeSatViewer', () => ({
  default: (props: Record<string, unknown>) => {
    cubeSatViewerPropsSpy(props);
    return <div data-testid="cube-sat-viewer-mock" />;
  },
}));

vi.mock('@/components/TelemetryOverlay', () => ({
  default: () => <div data-testid="telemetry-overlay-mock" />,
}));

vi.mock('@/components/ui/theme-toggle', () => ({
  default: () => null,
}));

function getLastViewerProps(): Record<string, unknown> {
  const calls = cubeSatViewerPropsSpy.mock.calls;
  return (calls[calls.length - 1]?.[0] ?? {}) as Record<string, unknown>;
}

describe('SimulationPage material selection', () => {
  it('shows the selected material with mass, feeds panelMass to params, and resets stale state on change', async () => {
    cubeSatViewerPropsSpy.mockClear();

    render(
      <MemoryRouter initialEntries={['/simulate?config=long-edge']}>
        <SimulationPage />
      </MemoryRouter>,
    );

    // Default material (FR4, 32 g) is visible and flows into engine params.
    expect(screen.getByText(/Panel: FR4 PCB — 32 g each/)).toBeInTheDocument();
    let props = getLastViewerProps() as { params: { panelMass: number } };
    expect(props.params.panelMass).toBeCloseTo(0.032, 9);

    // Start a run so there is in-progress state that must not survive a material change.
    fireEvent.click(screen.getByRole('button', { name: /^deploy$/i }));
    await waitFor(() => {
      const st = (getLastViewerProps() as { state: { deploying: boolean } }).state;
      expect(st.deploying).toBe(true);
    });

    // Switch material → full reset with the new panelMass.
    fireEvent.click(screen.getByRole('radio', { name: /Al \/ Kapton/i }));

    await waitFor(() => {
      const latest = getLastViewerProps() as {
        params: { panelMass: number };
        state: { deploying: boolean; time: number; panels: Array<{ angle: number }> };
      };
      // New mass reaches the engine params…
      expect(latest.params.panelMass).toBeCloseTo(0.050, 9);
      // …and the previous run's state is fully invalidated (fresh, paused, stowed).
      expect(latest.state.deploying).toBe(false);
      expect(latest.state.time).toBe(0);
      for (const p of latest.state.panels) expect(p.angle).toBe(0);
    });

    // The visible material/mass display refreshed too.
    expect(screen.getByText(/Panel: Al \/ Kapton Flex — 50 g each/)).toBeInTheDocument();
    expect(screen.queryByText(/Panel: FR4 PCB — 32 g each/)).not.toBeInTheDocument();
  });
});

describe('SimulationPage CoM toggle wiring', () => {
  it('passes showCoM to CubeSatViewer and toggles it from controls', async () => {
    cubeSatViewerPropsSpy.mockClear();

    render(
      <MemoryRouter initialEntries={['/simulate?config=long-edge']}>
        <SimulationPage />
      </MemoryRouter>,
    );

    expect(getLastViewerProps().showCoM).toBe(false);

    const label = screen.getByText('Centre of Mass');
    const row = label.closest('div');
    const toggle = row?.querySelector('button[role="switch"]') as HTMLButtonElement | null;

    expect(toggle).not.toBeNull();
    fireEvent.click(toggle as HTMLButtonElement);

    await waitFor(() => {
      expect(getLastViewerProps().showCoM).toBe(true);
    });
  });
});
