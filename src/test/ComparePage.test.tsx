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
import { NOT_APPLICABLE_TEXT, resolveStuckPanels } from '@/lib/scenario/scenarioSpec';

function makeFrame(time: number) {
  return {
    time,
    panelAngles: [0, 0, 0, 0, 0, 0],
    angularVelocity: { x: 0.05, y: 0.03, z: 0.02 },
    angularAcceleration: { x: 0.02, y: 0.01, z: 0.01 },
    totalContactForce: 4.2,
    detumbleAngularMomentum: 1.23e-3,
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

/**
 * Compare reads its scenario from the URL. `config` is the ACTIVE REFERENCE configuration: it is
 * highlighted and decides which failure modes the picker offers, but it never removes the other
 * configurations from the comparison.
 */
function renderCompare(search = '') {
  return render(
    <MemoryRouter initialEntries={[`/compare${search}`]}>
      <ComparePage />
    </MemoryRouter>,
  );
}

describe('ComparePage failure scenario phases', () => {
  beforeEach(() => {
    runFullSimulationMock.mockReset();
    runFullSimulationMock.mockImplementation(() => [makeFrame(0), makeFrame(2), makeFrame(4)]);
  });

  it('phase 1: exposes all-stuck option and passes each config its own canonical stuck indices', async () => {
    renderCompare();

    expect(screen.getByText('All Stuck')).toBeInTheDocument();

    selectScenario('All Stuck');

    // Sim data is generated asynchronously (one config per event-loop turn) and a
    // superseded selection cancels its remaining runs, so total call counts vary —
    // assert on the LAST full batch instead of an exact global count.
    // all-stuck is resolved PER CONFIGURATION now (shared resolver), so the 8-panel coupled
    // config gets all 8 indices rather than the old hard-coded [0..5].
    await waitFor(() => {
      const latestCalls = runFullSimulationMock.mock.calls.slice(-4);
      expect(latestCalls).toHaveLength(4);
      for (const [index, call] of latestCalls.entries()) {
        const config = CONFIGURATIONS[index];
        expect(call[0]).toBe(config.id);
        expect(call[3]).toEqual(resolveStuckPanels(config.id, 'all-stuck'));
      }
    });
    expect(runFullSimulationMock.mock.calls.at(-1)?.[3]).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('charts τ_avg,detumble vs time for all four configurations, defined and annotated', async () => {
    const { container } = renderCompare();

    // The chart, under the exact compact-symbol title, alongside the retained ω chart.
    await waitFor(() => {
      expect(screen.getByText('τ_avg,detumble (N·m) vs Time')).toBeInTheDocument();
    });
    expect(screen.getByText('Total Angular Velocity (°/s) vs Time')).toBeInTheDocument();

    // One series per configuration — the chart card carries all four in its legend.
    const chartCard = screen
      .getByText('τ_avg,detumble (N·m) vs Time')
      .closest('div.rounded-lg') as HTMLElement;
    expect(chartCard).not.toBeNull();
    for (const shortName of ['Long-edge', 'Double Long-edge', 'Short-edge', 'Coupled']) {
      expect(within(chartCard).getByText(shortName)).toBeInTheDocument();
    }

    // Symbol definition + formula, stated once on the page.
    expect(
      screen.getByText(/τ_avg,detumble denotes the average required detumbling torque/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/τ_avg,detumble = H_remove,max \/ 5,?400 s/),
    ).toBeInTheDocument();

    // The chart's own explanatory note.
    expect(
      screen.getByText(/Each point gives the average torque required to remove the body angular/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not an instantaneous simulated actuator torque/),
    ).toBeInTheDocument();

    // Summary-table scalar: fixture H = 1.23e-3 → 1.23e-3 / 5400 = 2.278e-7 N·m per config,
    // exponential-formatted. Sim data arrives asynchronously (one config per event-loop turn).
    expect(
      screen.getByRole('columnheader', { name: 'τ_avg,detumble (N·m)' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getAllByText('2.278e-7')).toHaveLength(4);
    });

    const text = container.textContent ?? '';
    expect(text.match(/average required detumbling torque/gi) ?? []).toHaveLength(1);
    expect(text).not.toMatch(/N·m·s(?!\/rad)/);
    expect(text).not.toMatch(/angular momentum to remove|Detumbling Energy|\bmJ\b|peak torque/i);
  });

  it('material selector change regenerates all runs with the new panelMass (no stale results)', async () => {
    const { container } = renderCompare();

    // Initial batch runs with the default FR4 mass (0.032 kg).
    await waitFor(() => {
      const latest = runFullSimulationMock.mock.calls.slice(-4);
      expect(latest).toHaveLength(4);
      for (const call of latest) {
        expect((call[1] as { panelMass: number }).panelMass).toBeCloseTo(0.032, 9);
      }
    });

    fireEvent.click(screen.getByRole('radio', { name: /CFRP/i }));

    // Every configuration is recomputed with the CFRP mass (0.020 kg).
    await waitFor(() => {
      const latest = runFullSimulationMock.mock.calls.slice(-4);
      expect(latest).toHaveLength(4);
      for (const call of latest) {
        expect((call[1] as { panelMass: number }).panelMass).toBeCloseTo(0.020, 9);
      }
    });

    // The visible material label (name + mass) updated with the selection.
    expect(container.textContent).toContain('CFRP Composite (20 g/panel)');
  });

  it.each([
    ['One panel stuck', '1 Panel Stuck', 'one-stuck', ''],
    ['Two panels (opposite)', '2 Opposite', 'two-opposite', '?config=short-edge'],
    ['Two panels (adjacent)', '2 Adjacent', 'two-adjacent', '?config=short-edge'],
    ['All panels stuck', 'All Stuck', 'all-stuck', ''],
  ])('phase 2: renders warning banner and per-config stuck counts for %s', async (_name, optionLabel, scenarioKey, search) => {
    renderCompare(search);

    selectScenario(optionLabel);

    const scenarioMatches = await screen.findAllByText(SCENARIO_TEXT[scenarioKey]);
    expect(scenarioMatches.length).toBeGreaterThan(0);

    for (const config of CONFIGURATIONS) {
      // Two-panel modes have no valid long-edge case: the badge says so rather than
      // reporting a substituted stuck count.
      const applicable =
        !['two-opposite', 'two-adjacent'].includes(scenarioKey) || config.id !== 'long-edge';
      const expected = applicable
        ? `${config.shortName}: ${resolveStuckPanels(config.id, scenarioKey as 'one-stuck').length} stuck`
        : `${config.shortName}: ${NOT_APPLICABLE_TEXT}`;
      expect(screen.getByText(expected)).toBeInTheDocument();
    }
  });

  it('phase 3: displays the FAILURE MODE badge on angular velocity chart header only during anomalies', () => {
    renderCompare();

    expect(screen.queryByText('FAILURE MODE')).not.toBeInTheDocument();

    selectScenario('1 Panel Stuck');

    expect(screen.getByText('FAILURE MODE')).toBeInTheDocument();
  });

  it('phase 4: renders the impact summary with per-config stuck, deployed, coupling, and progress severity', () => {
    const { container } = renderCompare();

    selectScenario('1 Panel Stuck');

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

// ─────────────────────────────────────────────────────────────────────────────
//  Reference configuration + two-panel topology validity.
//
//  Compare always shows every configuration the active failure mode applies to. The scenario's
//  `config` is the ACTIVE REFERENCE only — it highlights one configuration and decides which
//  failure modes are offered; it never filters the comparison set.
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage reference configuration and topology validity', () => {
  beforeEach(() => {
    runFullSimulationMock.mockReset();
    runFullSimulationMock.mockImplementation(() => [makeFrame(0), makeFrame(2), makeFrame(4)]);
  });

  it.each([
    ['nominal', 'Nominal'],
    ['one-stuck', '1 Panel Stuck'],
    ['all-stuck', 'All Stuck'],
  ])('renders all four configurations under %s', async (_mode, optionLabel) => {
    renderCompare();
    selectScenario(optionLabel);

    await waitFor(() => {
      const latest = runFullSimulationMock.mock.calls.slice(-4);
      expect(latest.map(call => call[0])).toEqual(CONFIGURATIONS.map(c => c.id));
    });

    const rows = screen.getAllByTestId('compare-summary-row');
    expect(rows).toHaveLength(4);
    expect(screen.queryByText(NOT_APPLICABLE_TEXT)).not.toBeInTheDocument();
  });

  it('visibly highlights the configuration selected on Simulation', () => {
    renderCompare('?config=short-edge');

    const rows = screen.getAllByTestId('compare-summary-row');
    const shortEdgeRow = rows.find(row => row.textContent?.includes('Short-edge'))!;
    const longEdgeRow = rows.find(row => row.textContent?.startsWith('Long-edge'))!;

    expect(within(shortEdgeRow).getByText('Active scenario')).toBeInTheDocument();
    expect(within(longEdgeRow).queryByText('Active scenario')).not.toBeInTheDocument();
    // The marker is used consistently — chart legends carry it too.
    expect(screen.getAllByText('Active scenario').length).toBeGreaterThan(1);
  });

  it.each([
    ['two-adjacent', '2 Adjacent'],
    ['two-opposite', '2 Opposite'],
  ])('excludes long-edge numerically and explains why under %s', async (_mode, optionLabel) => {
    renderCompare('?config=short-edge');
    selectScenario(optionLabel);

    // long-edge is never simulated for a two-panel mode — no fabricated result exists.
    await waitFor(() => {
      const latest = runFullSimulationMock.mock.calls.slice(-3);
      expect(latest.map(call => call[0])).toEqual([
        'double-long-edge',
        'short-edge',
        'short-edge-long-edge',
      ]);
    });
    expect(
      runFullSimulationMock.mock.calls.filter(call => call[0] === 'long-edge'),
    ).toHaveLength(0);

    // …and it is still listed, with an explicit not-applicable explanation rather than a
    // substituted failure mode or a blank cell.
    const rows = screen.getAllByTestId('compare-summary-row');
    expect(rows).toHaveLength(4);
    const longEdgeRow = rows.find(row => row.textContent?.startsWith('Long-edge'))!;
    expect(within(longEdgeRow).getByText(NOT_APPLICABLE_TEXT)).toBeInTheDocument();
    expect(screen.getAllByText(NOT_APPLICABLE_TEXT).length).toBeGreaterThan(1);
  });

  it('changing the reference configuration does not change the other comparison curves', async () => {
    const { unmount } = renderCompare('?config=long-edge&failure=one-stuck');

    await waitFor(() => {
      expect(runFullSimulationMock.mock.calls.slice(-4)).toHaveLength(4);
    });
    const firstBatch = runFullSimulationMock.mock.calls.slice(-4).map(call => [call[0], call[3]]);
    unmount();

    runFullSimulationMock.mockClear();
    renderCompare('?config=short-edge&failure=one-stuck');

    await waitFor(() => {
      expect(runFullSimulationMock.mock.calls.slice(-4)).toHaveLength(4);
    });
    const secondBatch = runFullSimulationMock.mock.calls.slice(-4).map(call => [call[0], call[3]]);

    // Identical configs, identical stuck indices — the reference config is presentation only.
    expect(secondBatch).toEqual(firstBatch);
  });
});
