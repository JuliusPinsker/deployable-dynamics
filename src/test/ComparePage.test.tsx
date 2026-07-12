import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { CONFIGURATIONS } from '@/lib/physics/types';

const runFullSimulationMock = vi.fn();

vi.mock('@/components/ui/theme-toggle', () => ({
  default: () => null,
}));

vi.mock('@/components/ui/chart', () => ({
  ChartContainer: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  ChartTooltip: () => null,
  ChartTooltipContent: () => null,
}));

vi.mock('recharts', () => {
  const MockChartNode = ({ children }: React.PropsWithChildren) => <div>{children}</div>;

  return {
    LineChart: MockChartNode,
    Line: MockChartNode,
    XAxis: MockChartNode,
    YAxis: MockChartNode,
    CartesianGrid: MockChartNode,
    BarChart: MockChartNode,
    Bar: MockChartNode,
    ResponsiveContainer: MockChartNode,
  };
});

vi.mock('@/components/ui/select', async () => {
  const ReactModule = await import('react');

  type SelectContextValue = {
    onValueChange?: (value: string) => void;
  };

  const SelectContext = ReactModule.createContext<SelectContextValue>({});

  return {
    Select: ({ children, onValueChange }: React.PropsWithChildren<{ onValueChange?: (value: string) => void }>) => (
      <SelectContext.Provider value={{ onValueChange }}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ children, className }: React.PropsWithChildren<{ className?: string }>) => (
      <div className={className}>{children}</div>
    ),
    SelectValue: ({ placeholder }: { placeholder?: string }) => <span>{placeholder}</span>,
    SelectContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
    SelectItem: ({ children, value }: React.PropsWithChildren<{ value: string }>) => {
      const ctx = ReactModule.useContext(SelectContext);

      return (
        <button type="button" onClick={() => ctx.onValueChange?.(value)}>
          {children}
        </button>
      );
    },
  };
});

vi.mock('@/lib/physics/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/physics/engine')>('@/lib/physics/engine');

  return {
    ...actual,
    runFullSimulation: (...args: unknown[]) => runFullSimulationMock(...args),
  };
});

import ComparePage from '@/pages/ComparePage';

function makeFrame(time: number) {
  return {
    time,
    panelAngles: [0, 0, 0, 0, 0, 0],
    angularVelocity: { x: 0.05, y: 0.03, z: 0.02 },
    angularAcceleration: { x: 0.02, y: 0.01, z: 0.01 },
    totalContactForce: 4.2,
    eDetumble: 0.123,
  };
}

const SCENARIO_TEXT: Record<string, string> = {
  'one-stuck': 'Panel Failure: 1 panel jammed at 0\u00b0 \u2014 asymmetric inertia disturbance',
  'two-opposite': 'Panel Failure: 2 opposite panels stuck \u2014 symmetric torque imbalance',
  'two-adjacent': 'Panel Failure: 2 adjacent panels stuck \u2014 net CoM offset + torque bias',
  'all-stuck': 'Catastrophic Failure: All panels locked \u2014 deployment aborted, CubeSat remains in tumble state',
};

function selectScenario(label: string) {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

describe('ComparePage failure scenario phases', () => {
  beforeEach(() => {
    runFullSimulationMock.mockReset();
    runFullSimulationMock.mockImplementation(() => [makeFrame(0), makeFrame(2), makeFrame(4)]);
  });

  it('phase 1: exposes all-stuck option and passes all stuck indices to runFullSimulation', async () => {
    render(
      <MemoryRouter>
        <ComparePage />
      </MemoryRouter>,
    );

    expect(screen.getByText('All panels stuck (total failure)')).toBeInTheDocument();

    selectScenario('All panels stuck (total failure)');

    await waitFor(() => {
      expect(runFullSimulationMock).toHaveBeenCalledTimes(8);
    });

    const latestCalls = runFullSimulationMock.mock.calls.slice(-4);
    expect(latestCalls).toHaveLength(4);

    for (const call of latestCalls) {
      expect(call[3]).toEqual([0, 1, 2, 3, 4, 5]);
    }
  });

  it.each([
    ['One panel stuck', 'one-stuck', 1],
    ['Two panels (opposite)', 'two-opposite', 2],
    ['Two panels (adjacent)', 'two-adjacent', 2],
    ['All panels stuck (total failure)', 'all-stuck', 6],
  ])('phase 2: renders warning banner and per-config stuck counts for %s', async (optionLabel, scenarioKey, stuckLength) => {
    render(
      <MemoryRouter>
        <ComparePage />
      </MemoryRouter>,
    );

    selectScenario(optionLabel);

    const scenarioMatches = await screen.findAllByText(SCENARIO_TEXT[scenarioKey]);
    expect(scenarioMatches.length).toBeGreaterThan(0);

    for (const config of CONFIGURATIONS) {
      const expected = `${config.shortName}: ${Math.min(stuckLength, config.panelCount)} stuck`;
      expect(screen.getByText(expected)).toBeInTheDocument();
    }
  });

  it('phase 3: displays the FAILURE MODE badge on angular velocity chart header only during anomalies', () => {
    render(
      <MemoryRouter>
        <ComparePage />
      </MemoryRouter>,
    );

    expect(screen.queryByText('FAILURE MODE')).not.toBeInTheDocument();

    selectScenario('One panel stuck');

    expect(screen.getByText('FAILURE MODE')).toBeInTheDocument();
  });

  it('phase 4: renders the impact summary with per-config stuck, deployed, coupling, and progress severity', () => {
    const { container } = render(
      <MemoryRouter>
        <ComparePage />
      </MemoryRouter>,
    );

    selectScenario('One panel stuck');

    expect(screen.getByText('Failure Mode Impact by Configuration')).toBeInTheDocument();
    expect(screen.getAllByText(SCENARIO_TEXT['one-stuck']).length).toBeGreaterThan(0);

    const progressBars = Array.from(container.querySelectorAll('div')).filter(
      (node) =>
        node.className.includes('h-1.5') &&
        node.className.includes('rounded-full') &&
        node.className.includes('transition-all'),
    );
    expect(progressBars.length).toBe(4);

    const greenBars = progressBars.filter((bar) => bar.className.includes('bg-green-500'));
    const amberBars = progressBars.filter((bar) => bar.className.includes('bg-amber-500'));
    const redBars = progressBars.filter((bar) => bar.className.includes('bg-red-500'));

    expect(greenBars.length).toBe(1);
    expect(amberBars.length).toBe(3);
    expect(redBars.length).toBe(0);

    for (const config of CONFIGURATIONS) {
      const stuckCount = Math.min(1, config.panelCount);
      const deployedCount = config.panelCount - stuckCount;
      const configHeader = screen.getByText(config.name);
      let configCard: HTMLElement | null = configHeader as HTMLElement;

      while (configCard && !configCard.className.includes('bg-muted/40')) {
        configCard = configCard.parentElement;
      }

      expect(configCard).not.toBeNull();

      const cardScope = within(configCard as HTMLElement);

      expect(cardScope.getByText(`${stuckCount} / ${config.panelCount}`)).toBeInTheDocument();
      expect(cardScope.getByText(String(deployedCount))).toBeInTheDocument();
    }

    expect(screen.getAllByText('Angular momentum coupling:').length).toBe(4);
  });
});
