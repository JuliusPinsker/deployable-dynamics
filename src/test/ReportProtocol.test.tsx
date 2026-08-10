import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import {
  buildProtocolLines,
  protocolToPdfLines,
  toPdfAscii,
} from '@/lib/scenario/protocol';
import { DEFAULT_PARAMS } from '@/lib/physics/types';

// ─────────────────────────────────────────────────────────────────────────────
//  Evaluation protocol: the report's statement of what was evaluated.
//
//  Screen and PDF are rendered from ONE builder, so they cannot drift. The PDF differs only by
//  spelling out characters jsPDF's standard fonts cannot draw (δ, τ, θ, ω, subscripts).
//  The heavy 42-scenario sweep is stubbed — this file is about the protocol statement, not physics.
// ─────────────────────────────────────────────────────────────────────────────

const ROW = {
  id: 'long-edge-one-stuck-fr4',
  config: 'long-edge' as const,
  failureMode: 'one-stuck' as const,
  material: 'fr4' as const,
  panelMass: 0.032,
  finalAngleDeg: 90,
  finalOmegaDegPerS: 2,
  averageRequiredDetumblingTorqueNm: 4e-7,
  deployTimeS: 1.25,
  peakOmegaDegPerS: 2,
};

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

vi.mock('@/lib/physics/reportData', async () => {
  const actual = await vi.importActual<typeof import('@/lib/physics/reportData')>(
    '@/lib/physics/reportData',
  );
  return {
    ...actual,
    generateReportRowsAsync: async (onProgress?: (done: number, total: number) => void) => {
      onProgress?.(1, 1);
      return [ROW];
    },
  };
});

import { jsPDF } from 'jspdf';
import ReportPage from '@/pages/ReportPage';

const PROTOCOL_INPUT = {
  delaySeconds: 0.005,
  selectedConfigCount: 4,
  selectedFailureCount: 4,
  selectedMaterialCount: 3,
  totalScenarios: 42,
  shownScenarios: 42,
};

describe('buildProtocolLines', () => {
  it('states δt, the fixed time step, the configuration and material counts, and the unfiltered matrix', () => {
    const lines = buildProtocolLines(PROTOCOL_INPUT);
    const byLabel = Object.fromEntries(lines.map(line => [line.label, line.value]));

    expect(byLabel['Timing discrepancy δt']).toContain('5 ms');
    expect(byLabel['Timing discrepancy δt']).toContain('0.005 s');
    expect(byLabel['Fixed physics time step']).toContain(
      `${(DEFAULT_PARAMS.timeStep * 1000).toFixed(2)} ms`,
    );
    expect(byLabel['Fixed physics time step']).toContain('1/1200 s');
    expect(byLabel['Configurations']).toContain('4 panel configurations');
    expect(byLabel['Material presets']).toContain('3 presets');
    expect(byLabel['Failure modes']).toMatch(/Topology-valid/);
    expect(byLabel['Failure modes']).toMatch(/not long-edge/);
    expect(byLabel['Unfiltered matrix']).toContain('42-scenario sweep');
  });

  it('reports the unfiltered total separately from the filtered count', () => {
    const lines = buildProtocolLines({ ...PROTOCOL_INPUT, shownScenarios: 6, selectedConfigCount: 1 });
    const activeFilters = lines.find(line => line.label === 'Active filters')!.value;

    expect(activeFilters).toContain('1/4 configurations');
    expect(activeFilters).toContain('6 of 42 scenarios shown');
    // The matrix statement is unaffected by filtering.
    expect(lines.find(line => line.label === 'Unfiltered matrix')!.value).toContain('42-scenario');
  });
});

describe('protocolToPdfLines', () => {
  it('preserves the content and differs only by ASCII substitution', () => {
    const lines = buildProtocolLines(PROTOCOL_INPUT);
    const pdfLines = protocolToPdfLines(lines);

    expect(pdfLines).toHaveLength(lines.length);
    lines.forEach((line, index) => {
      expect(pdfLines[index]).toBe(toPdfAscii(`${line.label}: ${line.value}`));
    });
    // δ/τ/θ/ω and subscripts cannot be drawn by jsPDF's standard fonts.
    for (const line of pdfLines) {
      expect(line).not.toMatch(/[δτθω₉₀]/);
    }
    expect(pdfLines.some(line => line.startsWith('Timing discrepancy dt:'))).toBe(true);
  });
});

describe('ReportPage protocol — screen and PDF agree', () => {
  it('prints the same protocol lines it displays, under the same δt and filters', async () => {
    render(
      <MemoryRouter initialEntries={['/report?dt=0.005&materials=fr4']}>
        <ReportPage />
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText('Evaluation protocol')).toBeInTheDocument();
    });

    const screenValues = screen.getAllByTestId('protocol-value').map(node => node.textContent ?? '');
    expect(screenValues.length).toBeGreaterThan(0);

    screen.getByRole('button', { name: 'Export PDF' }).click();

    const doc = (jsPDF as unknown as {
      mock: { results: Array<{ value: { text: { mock: { calls: unknown[][] } } } }> };
    }).mock.results[0].value;
    const pdfText = doc.text.mock.calls.map(call => String(call[0])).join('\n');

    // Every visible protocol value appears in the PDF, in its ASCII form.
    for (const value of screenValues) {
      expect(pdfText).toContain(toPdfAscii(value));
    }
    expect(pdfText).toContain('Evaluation protocol');
    // The filter state printed to the PDF is the page's own — materials narrowed to 1 of 3.
    expect(pdfText).toContain('1/3 materials');
  });
});
