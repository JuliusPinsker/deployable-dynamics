import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TelemetryOverlay from '@/components/TelemetryOverlay';
import {
  computeAverageRequiredDetumblingTorque,
  createInitialState,
  DETUMBLING_TIME_REQUIREMENT_S,
} from '@/lib/physics/engine';

// ─────────────────────────────────────────────────────────────────────────────
//  Live telemetry must present exactly ONE detumbling readout, under the compact
//  symbol τ_avg,detumble, in N·m. Never an angular momentum, an energy, a force,
//  the spelled-out phrase (defined on the Report/Compare pages and in the PDF,
//  not here), or the 5400 s allocation in the label.
// ─────────────────────────────────────────────────────────────────────────────
function renderOverlay(peakTorqueNm: number) {
  return render(
    <TelemetryOverlay
      state={createInitialState('long-edge')}
      detumblingTorqueNm={0}
      peakDetumblingTorqueNm={peakTorqueNm}
      delayMagnitude={0}
      delayUnit="ms"
      materialLabel="FR4 (32 g)"
    />,
  );
}

describe('TelemetryOverlay detumbling readout', () => {
  it('labels the row τ_avg,detumble and shows the formatted value in N·m', () => {
    // 4.93e-3 N·m·s / 5400 s ≈ 9.13e-7 N·m
    renderOverlay(computeAverageRequiredDetumblingTorque(4.93e-3));

    expect(screen.getByText('τ_avg,detumble')).toBeInTheDocument();
    expect(screen.getByText('9.130e-7 N·m')).toBeInTheDocument();
    expect(DETUMBLING_TIME_REQUIREMENT_S).toBe(5400);
  });

  it('does not spell the phrase out or state the 5400 s allocation here', () => {
    const { container } = renderOverlay(9.13e-7);
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/average required detumbling torque/i);
    expect(text).not.toMatch(/5,?400|allocation/i);
  });

  it('shows no angular-momentum, energy or force wording', () => {
    const { container } = renderOverlay(9.13e-7);
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/N·m·s/);
    expect(text).not.toMatch(/angular momentum|mJ|E_detumble|F_detumble|force required/i);
  });
});
