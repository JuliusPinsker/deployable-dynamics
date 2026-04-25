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
