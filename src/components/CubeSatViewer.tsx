import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import type { ConfigType, SpacecraftState, SimulationParams } from '@/lib/physics/types';
import { DEFAULT_PARAMS } from '@/lib/physics/types';

interface CubeSatModelProps {
  config: ConfigType;
  state: SpacecraftState;
  params?: SimulationParams;
  showLabels?: boolean;
  wireframe?: boolean;
  onPanelClick?: (index: number) => void;
  autoRotate?: boolean;
  size?: number;
}

const PANEL_COLOR = '#1a3a5c';
const PANEL_CELL_COLOR = '#1e3f8a';
const BODY_COLOR = '#2a2a2a';
const CONFIG_COLORS = ['#3b82f6', '#2dd4a8', '#f59e0b', '#a855f7'];

function SolarPanel({
  position,
  rotation,
  hingePosition,
  hingeAxis,
  angle,
  size,
  index,
  stuck,
  wireframe,
  showLabel,
  onClick,
  configColorIndex,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  hingePosition: [number, number, number];
  hingeAxis: 'x' | 'y' | 'z';
  angle: number;
  size: [number, number, number];
  index: number;
  stuck: boolean;
  wireframe: boolean;
  showLabel: boolean;
  onClick?: () => void;
  configColorIndex: number;
}) {
  const groupRef = useRef<THREE.Group>(null);

  useFrame(() => {
    if (!groupRef.current) return;
    const euler = new THREE.Euler(0, 0, 0);
    if (hingeAxis === 'x') euler.x = angle;
    else if (hingeAxis === 'y') euler.y = angle;
    else euler.z = angle;
    groupRef.current.rotation.copy(euler);
  });

  const panelColor = stuck ? '#ef4444' : CONFIG_COLORS[configColorIndex] || PANEL_CELL_COLOR;

  return (
    <group position={hingePosition} rotation={rotation}>
      <group ref={groupRef}>
        <group position={position}>
          <mesh onClick={onClick} castShadow>
            <boxGeometry args={size} />
            <meshStandardMaterial
              color={panelColor}
              wireframe={wireframe}
              metalness={0.6}
              roughness={0.3}
            />
          </mesh>
          {/* Solar cell grid lines */}
          <mesh position={[0, size[1] * 0.501, 0]}>
            <planeGeometry args={[size[0] * 0.95, size[2] * 0.95]} />
            <meshStandardMaterial
              color={panelColor}
              metalness={0.8}
              roughness={0.2}
              wireframe={wireframe}
            />
          </mesh>
          {showLabel && (
            <Text
              position={[0, size[1] * 0.6, 0]}
              fontSize={0.02}
              color={stuck ? '#ef4444' : '#ffffff'}
              anchorX="center"
              anchorY="middle"
            >
              {stuck ? `P${index + 1} STUCK` : `P${index + 1}`}
            </Text>
          )}
        </group>
      </group>
    </group>
  );
}

function getPanelConfigs(config: ConfigType, s: number, params: SimulationParams) {
  const pLen = params.panelLength * s * 8;
  const pWid = params.panelWidth * s * 8;
  const pThick = 0.005 * s;
  const bodyHalf = (params.bodySize * s * 4);

  switch (config) {
    case 'long-edge':
      return [
        { pos: [pLen / 2, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], hinge: [bodyHalf, 0, 0] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid] as [number, number, number] },
        { pos: [-pLen / 2, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], hinge: [-bodyHalf, 0, 0] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid] as [number, number, number] },
      ];
    case 'double-long-edge':
      return [
        { pos: [pLen / 2, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], hinge: [bodyHalf, 0, 0] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid] as [number, number, number] },
        { pos: [-pLen / 2, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], hinge: [-bodyHalf, 0, 0] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid] as [number, number, number] },
        { pos: [pLen / 2, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], hinge: [bodyHalf + pLen, 0, 0] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid] as [number, number, number] },
        { pos: [-pLen / 2, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], hinge: [-(bodyHalf + pLen), 0, 0] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid] as [number, number, number] },
      ];
    case 'short-edge':
      return [
        { pos: [pLen / 2, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], hinge: [bodyHalf, 0, 0] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid * 0.8] as [number, number, number] },
        { pos: [-pLen / 2, 0, 0] as [number, number, number], rot: [0, 0, 0] as [number, number, number], hinge: [-bodyHalf, 0, 0] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid * 0.8] as [number, number, number] },
        { pos: [0, 0, pLen / 2] as [number, number, number], rot: [0, Math.PI / 2, 0] as [number, number, number], hinge: [0, 0, bodyHalf] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid * 0.8] as [number, number, number] },
        { pos: [0, 0, -pLen / 2] as [number, number, number], rot: [0, -Math.PI / 2, 0] as [number, number, number], hinge: [0, 0, -bodyHalf] as [number, number, number], axis: 'z' as const, size: [pLen, pThick, pWid * 0.8] as [number, number, number] },
      ];
    case 'short-edge-long-edge':
      const configs = [];
      for (let i = 0; i < 4; i++) {
        const rotY = (i * Math.PI) / 2;
        const dx = Math.cos(rotY) * bodyHalf;
        const dz = Math.sin(rotY) * bodyHalf;
        configs.push(
          { pos: [pLen / 2, 0, 0] as [number, number, number], rot: [0, rotY, 0] as [number, number, number], hinge: [dx, 0, dz] as [number, number, number], axis: 'z' as const, size: [pLen * 0.7, pThick, pWid * 0.7] as [number, number, number] },
        );
        configs.push(
          { pos: [pLen / 2, 0, 0] as [number, number, number], rot: [0, rotY, 0] as [number, number, number], hinge: [dx + Math.cos(rotY) * pLen * 0.7, 0, dz + Math.sin(rotY) * pLen * 0.7] as [number, number, number], axis: 'z' as const, size: [pLen * 0.7, pThick, pWid * 0.7] as [number, number, number] },
        );
      }
      return configs;
    default:
      return [];
  }
}

function CubeSatBody({ size, wireframe }: { size: number; wireframe: boolean }) {
  return (
    <mesh castShadow receiveShadow>
      <boxGeometry args={[size, size, size]} />
      <meshStandardMaterial
        color={BODY_COLOR}
        wireframe={wireframe}
        metalness={0.4}
        roughness={0.6}
      />
    </mesh>
  );
}

function CubeSatScene({
  config,
  state,
  params = DEFAULT_PARAMS,
  showLabels = false,
  wireframe = false,
  onPanelClick,
  size = 1,
}: CubeSatModelProps) {
  const bodyRef = useRef<THREE.Group>(null);
  const bodySize = params.bodySize * size * 4;

  const panelConfigs = useMemo(() => getPanelConfigs(config, size, params), [config, size, params]);
  const configIndex = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'].indexOf(config);

  useFrame(() => {
    if (!bodyRef.current) return;
    bodyRef.current.rotation.set(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
    );
  });

  return (
    <group ref={bodyRef}>
      <CubeSatBody size={bodySize} wireframe={wireframe} />
      {panelConfigs.map((pc, i) => (
        <SolarPanel
          key={i}
          position={pc.pos}
          rotation={pc.rot}
          hingePosition={pc.hinge}
          hingeAxis={pc.axis}
          angle={state.panels[i]?.angle ?? 0}
          size={pc.size}
          index={i}
          stuck={state.panels[i]?.stuck ?? false}
          wireframe={wireframe}
          showLabel={showLabels}
          onClick={() => onPanelClick?.(i)}
          configColorIndex={configIndex}
        />
      ))}
    </group>
  );
}

export default function CubeSatViewer(props: CubeSatModelProps) {
  return (
    <Canvas
      camera={{ position: [2, 1.5, 2], fov: 45 }}
      style={{ background: 'transparent' }}
      gl={{ alpha: true, antialias: true }}
    >
      <ambientLight intensity={0.4} />
      <directionalLight position={[5, 5, 5]} intensity={0.8} castShadow />
      <directionalLight position={[-3, 2, -3]} intensity={0.3} />
      <CubeSatScene {...props} />
      <OrbitControls
        autoRotate={props.autoRotate}
        autoRotateSpeed={1}
        enableDamping
        dampingFactor={0.05}
      />
      <gridHelper args={[4, 20, '#333333', '#222222']} position={[0, -0.8, 0]} />
    </Canvas>
  );
}
