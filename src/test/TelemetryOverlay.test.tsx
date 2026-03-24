import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import TelemetryOverlay from '@/components/TelemetryOverlay';
import type { SpacecraftState } from '@/lib/physics/types';

function makeState(overrides?: Partial<SpacecraftState>): SpacecraftState {
  return {
    angularVelocity: { x: Math.PI, y: Math.PI / 2, z: 0 },
    angularAcceleration: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0 },
    time: 12.345,
    deploying: true,
    panels: [
      {
        id: 'P1',
        angle: Math.PI / 4,
        angularVelocity: 0,
        stuck: false,
        stuckAngle: 0,
        deployed: false,
        contactForce: 3.2,
      },
      {
        id: 'P2',
        angle: Math.PI / 2,
        angularVelocity: 0,
        stuck: false,
        stuckAngle: 0,
        deployed: true,
        contactForce: 12.4,
      },
    ],
    ...overrides,
  };
}

describe('TelemetryOverlay', () => {
  it('renders angular velocity, deployment percentage, contact force, and time', () => {
    const state = makeState();
    render(<TelemetryOverlay state={state} />);

    expect(screen.getByText('180.00°/s')).toBeInTheDocument();
    expect(screen.getByText('90.00°/s')).toBeInTheDocument();
    expect(screen.getByText('0.00°/s')).toBeInTheDocument();
    expect(screen.getByText('75%')).toBeInTheDocument();
    expect(screen.getByText('12.4 N')).toBeInTheDocument();
    expect(screen.getByText('12.35s')).toBeInTheDocument();
  });

  it('caps deployment percentage at 100%', () => {
    const state = makeState({
      panels: [
        {
          id: 'P1',
          angle: Math.PI,
          angularVelocity: 0,
          stuck: false,
          stuckAngle: 0,
          deployed: true,
          contactForce: 0,
        },
        {
          id: 'P2',
          angle: Math.PI,
          angularVelocity: 0,
          stuck: false,
          stuckAngle: 0,
          deployed: true,
          contactForce: 0,
        },
      ],
    });

    render(<TelemetryOverlay state={state} />);
    expect(screen.getByText('100%')).toBeInTheDocument();
  });

  it('renders gravity gradient torque when provided', () => {
    const state = makeState();
    render(<TelemetryOverlay state={state} gravityGradientTorqueMag={2e-6} />);

    expect(screen.getByText('2.000 µN·m')).toBeInTheDocument();
  });

  it('renders em dash for gravity gradient torque when absent', () => {
    const state = makeState();
    render(<TelemetryOverlay state={state} />);

    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('renders tip flex in mm when panel flex data exists', () => {
    const state = makeState({
      panels: [
        {
          id: 'P1',
          angle: Math.PI / 4,
          angularVelocity: 0,
          stuck: false,
          stuckAngle: 0,
          deployed: false,
          contactForce: 0,
          tipDeflectionDeg: 1,
        },
        {
          id: 'P2',
          angle: Math.PI / 4,
          angularVelocity: 0,
          stuck: false,
          stuckAngle: 0,
          deployed: false,
          contactForce: 0,
          tipDeflectionDeg: -2,
        },
      ],
    });

    render(<TelemetryOverlay state={state} panelLength={0.1} />);

    expect(screen.getByText('Tip Flex')).toBeInTheDocument();
    expect(screen.getByText('3.49 mm')).toBeInTheDocument();
  });
});
