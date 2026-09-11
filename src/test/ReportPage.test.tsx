import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import ReportPage from '@/pages/ReportPage';

vi.mock('jspdf', () => {
  const mockDoc = {
    setFontSize: vi.fn(),
    setFont: vi.fn(),
    text: vi.fn(),
    setDrawColor: vi.fn(),
    line: vi.fn(),
    autoTable: vi.fn(),
    save: vi.fn(),
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    lastAutoTable: { finalY: 100 },
  };
  const jsPDF = vi.fn(() => mockDoc);
  return { jsPDF };
});

vi.mock('jspdf-autotable', () => ({ default: vi.fn() }));

const WrappedReportPage = () => (
  <MemoryRouter>
    <ReportPage />
  </MemoryRouter>
);

describe('ReportPage', () => {
  // The 42-row sweep runs full physics-driven simulations (~4 s alone, longer
  // under parallel-worker CPU contention), so give the first render generous room.
  it('renders 42 scenario rows', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        const rows = screen.getAllByTestId('report-row');
        expect(rows).toHaveLength(42);
      },
      { timeout: 80000 },
    );
  }, 90000);

  it('names the metric τ_avg,detumble and defines the symbol exactly once', async () => {
    const { container } = render(<WrappedReportPage />);

    await waitFor(
      () => screen.getAllByTestId('report-row'),
      { timeout: 80000 },
    );

    expect(
      screen.getByRole('columnheader', { name: 'τ_avg,detumble (N·m)' }),
    ).toBeInTheDocument();

    // Symbol definition + formula, stated once alongside the metric card.
    expect(
      screen.getByText(/τ_avg,detumble denotes the average required detumbling torque/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/τ_avg,detumble = H_remove,max \/ 5,?400 s/),
    ).toBeInTheDocument();

    // The 5400 s figure is presented as an assumption, not a simulation output.
    expect(
      screen.getByText(/assumed 5,400 s one-orbit LEO detumbling allocation/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/not a simulated actuator torque/),
    ).toBeInTheDocument();

    const text = container.textContent ?? '';

    // The spelled-out phrase survives ONLY inside that one definition sentence.
    expect(text.match(/average required detumbling torque/gi) ?? []).toHaveLength(1);

    // Removed blocks and superseded terminology.
    expect(text).not.toMatch(/Worst-Case Scenario/i);
    expect(text).not.toMatch(/Tumble onset coincides with deployment start/i);
    expect(text).not.toMatch(/Methodology & limitations/i);
    expect(text).not.toMatch(/N·m·s(?!\/rad)/);
    expect(text).not.toMatch(/angular momentum to remove/i);
    expect(text).not.toMatch(/mJ|E_detumble|F_detumble|force required|\bLED\b|peak torque/i);
  }, 90000);

  it('exports the report to PDF using τ_avg,detumble, defined once', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => screen.getAllByTestId('report-row'),
      { timeout: 80000 },
    );

    const exportBtn = screen.getByRole('button', { name: /export pdf/i });
    fireEvent.click(exportBtn);

    const { jsPDF } = await import('jspdf');
    expect(jsPDF).toHaveBeenCalled();

    const doc = (jsPDF as unknown as { mock: { results: Array<{ value: { text: { mock: { calls: unknown[][] } } } }> } })
      .mock.results[0].value;
    const pdfText = doc.text.mock.calls.map(call => String(call[0])).join('\n');

    // jsPDF cannot render "τ" in its standard fonts, so the PDF spells the symbol "tau".
    expect(pdfText).toMatch(/tau_avg,detumble \(N·m\)/);
    expect(pdfText).toMatch(/tau_avg,detumble = H_remove,max \/ 5400 s/);
    expect(pdfText).toMatch(
      /tau_avg,detumble denotes the average required detumbling torque/,
    );
    expect(pdfText).toMatch(
      /assumed 5,400 s one-orbit LEO detumbling allocation.*not a simulated actuator torque/s,
    );

    // Defined once, then only the symbol is used.
    expect(pdfText.match(/average required detumbling torque/gi) ?? []).toHaveLength(1);

    // Removed blocks and superseded terminology.
    expect(pdfText).not.toMatch(/Worst-Case Scenario/i);
    expect(pdfText).not.toMatch(/Tumble onset coincides with deployment start/i);
    expect(pdfText).not.toMatch(/Method note:/i);
    expect(pdfText).not.toMatch(/N·m·s(?!\/rad)/);
    expect(pdfText).not.toMatch(/angular momentum to remove/i);
    expect(pdfText).not.toMatch(/mJ|E_detumble|F_detumble|\bLED\b|peak torque/i);
  }, 90000);

  it('displays the coupled configuration as "Coupled" and never as the raw config id', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        expect(screen.getAllByTestId('report-row')).toHaveLength(42);
      },
      { timeout: 80000 },
    );

    expect(screen.getAllByText('Coupled').length).toBeGreaterThan(0);
    expect(screen.queryByText('short-edge-long-edge')).not.toBeInTheDocument();
  }, 90000);

  it('never displays none or nominal as a scenario failure mode', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        expect(screen.getAllByTestId('report-row')).toHaveLength(42);
      },
      { timeout: 80000 },
    );

    for (const row of screen.getAllByTestId('report-row') as HTMLTableRowElement[]) {
      const failureCellText = row.cells[1].textContent;
      expect(failureCellText).not.toMatch(/^none$/i);
      expect(failureCellText).not.toMatch(/^nominal$/i);
      expect(['one-stuck', 'two-adjacent-stuck', 'two-opposite-stuck', 'all-stuck']).toContain(
        failureCellText,
      );
    }
  }, 90000);

  it('narrowing the Configuration filter to long-edge only clears two-adjacent-stuck/two-opposite-stuck and shows its 6 valid rows', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        expect(screen.getAllByTestId('report-row')).toHaveLength(42);
      },
      { timeout: 80000 },
    );

    // Starts checked — every failure mode is selected by default.
    expect((screen.getByLabelText('two-adjacent-stuck') as HTMLInputElement).checked).toBe(true);

    // Narrow the Configuration filter down to long-edge only.
    fireEvent.click(screen.getByLabelText('double-long-edge'));
    fireEvent.click(screen.getByLabelText('short-edge'));
    fireEvent.click(screen.getByLabelText('Coupled'));

    // The now-inapplicable failure-mode checkboxes disappear entirely — a hidden/invalid
    // selection must never silently zero out the visible rows.
    await waitFor(() => {
      expect(screen.queryByLabelText('two-adjacent-stuck')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('two-opposite-stuck')).not.toBeInTheDocument();
    });

    // Exactly the 6 valid long-edge rows remain: one-stuck + all-stuck × 3 materials.
    await waitFor(() => {
      expect(screen.getAllByTestId('report-row')).toHaveLength(6);
    });
  }, 90000);

  it('PDF export: scenario rows never contain none/nominal, and the coupled config uses its canonical phrase', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        expect(screen.getAllByTestId('report-row')).toHaveLength(42);
      },
      { timeout: 80000 },
    );

    const exportBtn = screen.getByRole('button', { name: /export pdf/i });
    fireEvent.click(exportBtn);

    const { default: autoTable } = await import('jspdf-autotable');
    const autoTableMock = autoTable as unknown as { mock: { calls: unknown[][] } };
    const lastCall = autoTableMock.mock.calls.at(-1) as [unknown, { body: string[][] }];
    const body = lastCall[1].body;

    expect(body).toHaveLength(42);

    const validFailureLabels = ['one-stuck', 'two-adjacent-stuck', 'two-opposite-stuck', 'all-stuck'];
    for (const [config, failureMode] of body) {
      expect(config).not.toMatch(/^none$/i);
      expect(config).not.toMatch(/^nominal$/i);
      expect(failureMode).not.toMatch(/^none$/i);
      expect(failureMode).not.toMatch(/^nominal$/i);
      expect(validFailureLabels).toContain(failureMode);
    }

    expect(body.some(([config]) => config === 'Coupled')).toBe(true);
    expect(body.some(([config]) => config === 'short-edge-long-edge')).toBe(false);
  }, 90000);

  it('displays the exact revised subtitle on the rendered page, with no multiplication-style factor expression', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        expect(screen.getAllByTestId('report-row')).toHaveLength(42);
      },
      { timeout: 80000 },
    );

    expect(
      screen.getByText(
        '42-Scenario Failure-Mode Sweep Across Four Panel Configurations and Three Material Presets',
      ),
    ).toBeInTheDocument();

    const bodyText = document.body.textContent ?? '';
    expect(bodyText).not.toMatch(/Config\s*x\s*Failure Mode\s*x\s*Material/i);
    expect(bodyText).not.toMatch(/\d\s*×\s*\d/);
  }, 90000);

  it('PDF export: writes the exact revised subtitle, with no multiplication-style factor expression', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        expect(screen.getAllByTestId('report-row')).toHaveLength(42);
      },
      { timeout: 80000 },
    );

    const exportBtn = screen.getByRole('button', { name: /export pdf/i });
    fireEvent.click(exportBtn);

    const { jsPDF } = await import('jspdf');
    const doc = (jsPDF as unknown as { mock: { results: Array<{ value: { text: { mock: { calls: unknown[][] } } } }> } })
      .mock.results[0].value;
    const pdfText = doc.text.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');

    expect(pdfText).toMatch(
      /42-Scenario Failure-Mode Sweep Across Four Panel Configurations and Three Material Presets/,
    );
    expect(pdfText).not.toMatch(/Config\s*x\s*Failure Mode\s*x\s*Material/i);
    expect(pdfText).not.toMatch(/\d\s*×\s*\d/);
  }, 90000);

  it('displays scenario-table metric labels in reader-facing notation, not internal identifier notation', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        expect(screen.getAllByTestId('report-row')).toHaveLength(42);
      },
      { timeout: 80000 },
    );

    expect(screen.getByRole('columnheader', { name: 'Final θ (°)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 't₉₀ (s)' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Peak ω (°/s)' })).toBeInTheDocument();

    const headerText = screen.getAllByRole('columnheader').map((th) => th.textContent);
    expect(headerText).not.toContain('theta_final (deg)');
    // "Final ω (°/s)" was removed entirely — it was a byte-identical alias of "Peak ω (°/s)".
    expect(headerText).not.toContain('Final ω (°/s)');
    expect(headerText).not.toContain('w_final (deg/s)');
    expect(headerText).not.toContain('t_deploy,90 (s)');
    expect(headerText).not.toContain('w_peak (deg/s)');
  }, 90000);

  it('sorts each configuration\'s rows by the defined failure-mode order, then by material order (FR4, Al/Kapton, CFRP)', async () => {
    render(<WrappedReportPage />);

    await waitFor(
      () => {
        expect(screen.getAllByTestId('report-row')).toHaveLength(42);
      },
      { timeout: 80000 },
    );

    // Narrow to a single 4-failure-mode config so the expected row order is unambiguous.
    fireEvent.click(screen.getByLabelText('long-edge'));
    fireEvent.click(screen.getByLabelText('short-edge'));
    fireEvent.click(screen.getByLabelText('Coupled'));

    await waitFor(() => {
      expect(screen.getAllByTestId('report-row')).toHaveLength(12);
    });

    const rows = screen.getAllByTestId('report-row') as HTMLTableRowElement[];
    const expectedOrder = [
      ['one-stuck', 'FR4'], ['one-stuck', 'Al/Kapton'], ['one-stuck', 'CFRP'],
      ['two-adjacent-stuck', 'FR4'], ['two-adjacent-stuck', 'Al/Kapton'], ['two-adjacent-stuck', 'CFRP'],
      ['two-opposite-stuck', 'FR4'], ['two-opposite-stuck', 'Al/Kapton'], ['two-opposite-stuck', 'CFRP'],
      ['all-stuck', 'FR4'], ['all-stuck', 'Al/Kapton'], ['all-stuck', 'CFRP'],
    ];
    rows.forEach((row, i) => {
      expect(row.cells[1].textContent).toBe(expectedOrder[i][0]);
      expect(row.cells[2].textContent).toBe(expectedOrder[i][1]);
    });
  }, 90000);
});
