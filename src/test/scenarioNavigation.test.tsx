import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, useLocation } from 'react-router-dom';

// ─────────────────────────────────────────────────────────────────────────────
//  Cross-page scenario persistence.
//
//  The active scenario lives ONLY in the URL, so these tests mount the REAL route table and
//  navigate with the real header links — the same path a user takes. Anything that survives
//  here also survives a refresh, a copied link, and browser Back, because there is no state
//  outside the URL to lose.
//
//  The 3D viewer, charts, and the ~24 s report physics sweep are mocked: this file is about
//  state plumbing, and the physics is covered by its own suites.
// ─────────────────────────────────────────────────────────────────────────────

vi.mock('@/components/ui/theme-toggle', () => ({ default: () => null }));

vi.mock('@/components/CubeSatViewer', () => ({
  default: () => <div data-testid="cube-sat-viewer-mock" />,
}));

vi.mock('@/components/TelemetryOverlay', () => ({
  default: () => <div data-testid="telemetry-overlay-mock" />,
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
  const SelectContext = ReactModule.createContext<{ onValueChange?: (value: string) => void }>({});

  return {
    Select: ({ children, onValueChange }: React.PropsWithChildren<{ onValueChange?: (value: string) => void }>) => (
      <SelectContext.Provider value={{ onValueChange }}>
        <div>{children}</div>
      </SelectContext.Provider>
    ),
    SelectTrigger: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
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

// Run the comparison sweep instantly instead of the real physics.
vi.mock('@/lib/physics/engine', async () => {
  const actual = await vi.importActual<typeof import('@/lib/physics/engine')>('@/lib/physics/engine');
  return {
    ...actual,
    runFullSimulation: () => [
      {
        time: 0,
        panelAngles: [0, 0],
        angularVelocity: { x: 0, y: 0, z: 0, length: () => 0 },
        angularAcceleration: { x: 0, y: 0, z: 0 },
        totalContactTorque: 0,
        detumbleAngularMomentum: 0,
      },
    ],
  };
});

// The report's 42-scenario sweep takes ~24 s of real physics — replaced with a stub matrix that
// keeps the shape (per-config valid modes × materials) so row counts stay meaningful.
vi.mock('@/lib/physics/reportData', async () => {
  const actual = await vi.importActual<typeof import('@/lib/physics/reportData')>(
    '@/lib/physics/reportData',
  );
  const rows = actual.REPORT_CONFIGS.flatMap(config =>
    actual.CONFIG_FAILURE_MODES[config].flatMap(failureMode =>
      actual.REPORT_MATERIALS.map(material => ({
        id: `${config}-${failureMode}-${material}`,
        config,
        failureMode,
        material,
        panelMass: 0.032,
        finalAngleDeg: 90,
        averageRequiredDetumblingTorqueNm: 1e-7,
        deployTimeS: 1.2,
        peakOmegaDegPerS: 1,
      })),
    ),
  );
  return {
    ...actual,
    generateReportRowsAsync: async (onProgress?: (done: number, total: number) => void) => {
      onProgress?.(rows.length, rows.length);
      return rows;
    },
  };
});

import { AppRoutes } from '@/App';

/** Surfaces the live URL so assertions can read the canonical scenario representation. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderApp(initialEntry: string) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <AppRoutes />
      <LocationProbe />
    </MemoryRouter>,
  );
}

function currentUrl(): URL {
  return new URL(screen.getByTestId('location').textContent ?? '', 'http://localhost');
}

function scenarioFromUrl() {
  const params = currentUrl().searchParams;
  return {
    config: params.get('config'),
    material: params.get('material'),
    dt: params.get('dt'),
    failure: params.get('failure'),
  };
}

function navigateVia(label: string) {
  fireEvent.click(screen.getByRole('link', { name: label }));
}

const FULL_SCENARIO = '?config=short-edge&material=cfrp&dt=0.005&failure=two-adjacent';

describe('scenario persistence across pages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps a Simulation scenario identical after navigating to Compare', async () => {
    renderApp(`/simulate${FULL_SCENARIO}`);
    const before = scenarioFromUrl();

    navigateVia('Compare');

    await waitFor(() => {
      expect(currentUrl().pathname).toBe('/compare');
    });
    expect(scenarioFromUrl()).toEqual(before);
    expect(before).toEqual({
      config: 'short-edge',
      material: 'cfrp',
      dt: '0.005',
      failure: 'two-adjacent',
    });
  });

  it('keeps a Compare scenario identical after navigating back to Simulation', async () => {
    renderApp(`/compare${FULL_SCENARIO}`);
    const before = scenarioFromUrl();

    navigateVia('Simulation');

    await waitFor(() => {
      expect(currentUrl().pathname).toBe('/simulate');
    });
    expect(scenarioFromUrl()).toEqual(before);
  });

  it('restores config, material, δt, and failure mode from a directly opened URL', () => {
    // Equivalent to a refresh or a pasted link: nothing but the URL is available.
    renderApp(`/simulate${FULL_SCENARIO}`);

    expect(scenarioFromUrl()).toEqual({
      config: 'short-edge',
      material: 'cfrp',
      dt: '0.005',
      failure: 'two-adjacent',
    });
    // …and the controls reflect every one of those values.
    expect(screen.getByRole('radio', { name: /CFRP/i })).toHaveAttribute('aria-checked', 'true');
    expect((screen.getByLabelText('Timing Discrepancy δt') as HTMLInputElement).value).toBe('5');
    expect(screen.getByRole('button', { name: 'ms' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('2 Adjacent Stuck — Asymmetric release')).toBeInTheDocument();
  });

  it('carries the active scenario on every header link, on every page', async () => {
    renderApp(`/simulate${FULL_SCENARIO}`);

    for (const label of ['Overview', 'Simulation', 'Compare', 'Report']) {
      const href = screen.getByRole('link', { name: label }).getAttribute('href') ?? '';
      const params = new URL(href, 'http://localhost').searchParams;
      expect(params.get('config')).toBe('short-edge');
      expect(params.get('material')).toBe('cfrp');
      expect(params.get('dt')).toBe('0.005');
      expect(params.get('failure')).toBe('two-adjacent');
    }

    // The same holds after landing on another page.
    navigateVia('Report');
    await waitFor(() => expect(currentUrl().pathname).toBe('/report'));
    const compareHref = screen.getByRole('link', { name: 'Compare' }).getAttribute('href') ?? '';
    expect(new URL(compareHref, 'http://localhost').searchParams.get('material')).toBe('cfrp');
  });

  it('reconciles an invalid config/failure combination to nominal', () => {
    renderApp('/simulate?config=long-edge&failure=two-adjacent');

    expect(scenarioFromUrl().failure).toBe('nominal');
    expect(screen.queryByText('2 Adjacent Stuck — Asymmetric release')).not.toBeInTheDocument();
  });

  it('offers long-edge no two-panel failure modes on Simulation, Compare, or Report', async () => {
    renderApp('/simulate?config=long-edge');
    expect(screen.getByRole('button', { name: 'Nominal All panels free' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^2 Adjacent/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^2 Opposite/ })).not.toBeInTheDocument();

    navigateVia('Compare');
    await waitFor(() => expect(currentUrl().pathname).toBe('/compare'));
    expect(screen.queryByRole('button', { name: '2 Adjacent' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '2 Opposite' })).not.toBeInTheDocument();

    // On the Report the two-panel modes are filter options; narrowing the configuration
    // filter to long-edge alone removes them, because no selected config generates such rows.
    renderApp('/report?configs=long-edge');
    await waitFor(() => {
      expect(screen.queryByLabelText('two-adjacent-stuck')).not.toBeInTheDocument();
    });
    expect(screen.queryByLabelText('two-opposite-stuck')).not.toBeInTheDocument();
  });

  it('preserves Report filters through a round-trip to Simulation and back', async () => {
    renderApp('/report?configs=short-edge&failures=all-stuck&materials=fr4,cfrp');

    await waitFor(() => {
      expect(screen.getByText(/Showing \d+ of 42 scenarios/)).toBeInTheDocument();
    });

    navigateVia('Simulation');
    await waitFor(() => expect(currentUrl().pathname).toBe('/simulate'));

    // Change the scenario while away from the report.
    fireEvent.click(screen.getByRole('button', { name: /Short-edge\s*4 panels/ }));
    await waitFor(() => expect(scenarioFromUrl().config).toBe('short-edge'));

    navigateVia('Report');
    await waitFor(() => expect(currentUrl().pathname).toBe('/report'));

    // The report's own filter parameters came back untouched…
    const params = currentUrl().searchParams;
    expect(params.get('configs')).toBe('short-edge');
    expect(params.get('failures')).toBe('all-stuck');
    expect(params.get('materials')).toBe('fr4,cfrp');
    // …and the scenario change travelled with it.
    expect(params.get('config')).toBe('short-edge');
  });
});

describe('Report scope separation', () => {
  it('generates the full 42-scenario matrix regardless of the active scenario', async () => {
    renderApp('/report?config=short-edge&material=cfrp&failure=all-stuck');

    await waitFor(() => {
      expect(screen.getAllByTestId('report-row')).toHaveLength(42);
    });

    // The active scenario is displayed as context, not as a filter.
    expect(screen.getByTestId('active-scenario-config')).toHaveTextContent('short-edge');
    expect(screen.getByTestId('active-scenario-material')).toHaveTextContent('CFRP');
    expect(screen.getByTestId('active-scenario-failure')).toHaveTextContent('All Stuck');
    expect(screen.getByText(/Showing 42 of 42 scenarios/)).toBeInTheDocument();

    // Every filter checkbox is still checked — the scenario never narrowed them.
    for (const label of ['short-edge', 'FR4', 'Al/Kapton', 'CFRP', 'one-stuck', 'all-stuck']) {
      expect((screen.getByLabelText(label) as HTMLInputElement).checked).toBe(true);
    }
  });

  it('keeps two-panel modes available when long-edge is selected alongside a 4-panel config', async () => {
    renderApp('/report?configs=long-edge,short-edge');

    await waitFor(() => {
      expect(screen.getByLabelText('two-adjacent-stuck')).toBeInTheDocument();
    });
    // Union, not intersection: short-edge supports them, so they stay offered and selected.
    expect((screen.getByLabelText('two-adjacent-stuck') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('two-opposite-stuck') as HTMLInputElement).checked).toBe(true);

    // The rows shown for those modes contain no long-edge entry — the matrix never had one.
    const rows = screen.getAllByTestId('report-row');
    const twoPanelRows = rows.filter(row => /two-(adjacent|opposite)-stuck/.test(row.textContent ?? ''));
    expect(twoPanelRows.length).toBeGreaterThan(0);
    for (const row of twoPanelRows) {
      expect(within(row).queryByText('long-edge')).not.toBeInTheDocument();
    }
  });

  it('carries δt into the report URL and states it in the evaluation protocol', async () => {
    renderApp('/report?dt=0.005');

    await waitFor(() => {
      expect(screen.getByTestId('active-scenario-dt')).toHaveTextContent('5 ms');
    });
    expect(currentUrl().searchParams.get('dt')).toBe('0.005');

    const protocolValues = screen.getAllByTestId('protocol-value').map(node => node.textContent ?? '');
    expect(protocolValues.some(value => value.includes('5 ms'))).toBe(true);
    expect(protocolValues.some(value => value.includes('0.83 ms'))).toBe(true);
    expect(protocolValues.some(value => value.includes('42-scenario sweep'))).toBe(true);
  });
});
