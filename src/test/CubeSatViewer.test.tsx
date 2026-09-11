import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CubeSatViewer from '@/components/CubeSatViewer';
import type { SpacecraftState } from '@/lib/physics/types';

const canvasMock = vi.fn((props: React.PropsWithChildren<Record<string, unknown>>) => {
  return <div data-testid="canvas-mock">{null}</div>;
});

vi.mock('@react-three/fiber', () => ({
  Canvas: (props: React.PropsWithChildren<Record<string, unknown>>) => canvasMock(props),
  useFrame: () => undefined,
  useThree: () => ({
    camera: {
      add: () => undefined,
      remove: () => undefined,
      quaternion: {
        copy: () => undefined,
        clone: () => ({ invert: () => ({ multiply: () => ({}) }) }),
      },
    },
  }),
}));

vi.mock('@react-three/drei', () => ({
  OrbitControls: () => null,
  Text: () => null,
}));

function makeState(panelCount: number): SpacecraftState {
  return {
    angularVelocity: { x: 0, y: 0, z: 0 },
    angularAcceleration: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0 },
    time: 0,
    deploying: false,
    panels: Array.from({ length: panelCount }, (_, i) => ({
      id: `P${i + 1}`,
      angle: 0,
      angularVelocity: 0,
      stuck: false,
      stuckAngle: 0,
      deployed: false,
      contactTorque: 0,
    })),
  };
}

describe('CubeSatViewer', () => {
  beforeEach(() => {
    canvasMock.mockClear();
  });

  it('renders without crashing when autoRotate is enabled', () => {
    render(
      <CubeSatViewer
        config="long-edge"
        state={makeState(2)}
        autoRotate
      />,
    );

    expect(canvasMock.mock.calls.length).toBeGreaterThan(0);
  });

  it('wires Canvas with expected camera defaults', () => {
    render(
      <CubeSatViewer
        config="long-edge"
        state={makeState(2)}
      />,
    );

    expect(canvasMock.mock.calls.length).toBeGreaterThan(0);
    const firstCallProps = canvasMock.mock.calls[0][0] as { camera: { position: number[]; fov: number; up: number[] } };
    expect(firstCallProps.camera.position).toEqual([1.5, 1.5, 1.5]);
    expect(firstCallProps.camera.fov).toBe(45);
    expect(firstCallProps.camera.up).toEqual([0, 0, 1]);
  });

  it('rerenders cleanly when switching to another configuration', () => {
    const { rerender } = render(
      <CubeSatViewer
        config="long-edge"
        state={makeState(2)}
      />,
    );

    const callsAfterFirstRender = canvasMock.mock.calls.length;
    expect(callsAfterFirstRender).toBeGreaterThan(0);

    rerender(
      <CubeSatViewer
        config="short-edge-long-edge"
        state={makeState(8)}
      />,
    );

    const callsAfterRerender = canvasMock.mock.calls.length;
    expect(callsAfterRerender).toBeGreaterThan(callsAfterFirstRender);
  });

  it('shows CoM telemetry overlay when showCoM is enabled', () => {
    render(
      <CubeSatViewer
        config="long-edge"
        state={makeState(2)}
        showCoM
      />,
    );

    expect(screen.getByText('Centre of Mass')).toBeInTheDocument();
    expect(screen.getByText('Offset:')).toBeInTheDocument();
  });

  it('hides CoM telemetry overlay when showCoM is disabled', () => {
    render(
      <CubeSatViewer
        config="long-edge"
        state={makeState(2)}
        showCoM={false}
      />,
    );

    expect(screen.queryByText('Centre of Mass')).not.toBeInTheDocument();
  });
});
