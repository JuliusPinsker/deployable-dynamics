import React, { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, Text } from '@react-three/drei';
import * as THREE from 'three';
import type { ConfigType, SpacecraftState, SimulationParams, ThermalState } from '@/lib/physics/types';
import { DEFAULT_PARAMS } from '@/lib/physics/types';
import { computeSystemCoM } from '@/lib/physics/engine';

interface CubeSatModelProps {
  config: ConfigType;
  state: SpacecraftState;
  params?: SimulationParams;
  showLabels?: boolean;
  showAxes?: boolean;
  wireframe?: boolean;
  onPanelClick?: (index: number) => void;
  autoRotate?: boolean;
  size?: number;
  /** When true, panel colours reflect temperature */
  thermalEnabled?: boolean;
  /** Current thermal state - temperature drives panel colour */
  thermalState?: ThermalState;
  showCoM?: boolean;
}

/**
 * Interpolates panel colour based on temperature.
 * Cold (< -20°C): blue (#3b82f6)
 * Neutral (~20°C): original panel colour
 * Hot (> 60°C): orange-red (#ef4444)
 */
function getThermalColor(temperatureDeg: number): string {
  // Define temperature range
  const coldTemp = -20;  // °C - deep blue
  const neutralTemp = 20; // °C - neutral
  const hotTemp = 60;     // °C - hot red

  // Clamp temperature
  const t = Math.max(coldTemp, Math.min(hotTemp, temperatureDeg));

  if (t <= neutralTemp) {
    // Cold to neutral: blue (#3b82f6) to dark blue (#1e3f8a)
    const ratio = (t - coldTemp) / (neutralTemp - coldTemp);
    // Interpolate from cold blue to neutral grey-blue
    const r = Math.round(59 + ratio * (30 - 59));
    const g = Math.round(130 + ratio * (63 - 130));
    const b = Math.round(246 + ratio * (138 - 246));
    return `rgb(${r}, ${g}, ${b})`;
  } else {
    // Neutral to hot: dark blue (#1e3f8a) to orange-red (#ef4444)
    const ratio = (t - neutralTemp) / (hotTemp - neutralTemp);
    const r = Math.round(30 + ratio * (239 - 30));
    const g = Math.round(63 + ratio * (68 - 63));
    const b = Math.round(138 + ratio * (68 - 138));
    return `rgb(${r}, ${g}, ${b})`;
  }
}

const PANEL_COLOR = '#1a3a5c';
const PANEL_CELL_COLOR = '#1e3f8a';
const BODY_COLOR = '#c0c0c0';
const CONFIG_COLORS = ['#3b82f6', '#2dd4a8', '#f59e0b', '#a855f7'];

function kelvinToRGB(T: number): string {
  // Map temperature range 150 K (deep shadow) to 380 K (sunlit) to colour
  const cold = { r: 30, g: 80, b: 200 };
  const neutral = { r: 40, g: 160, b: 80 };
  const hot = { r: 255, g: 80, b: 10 };
  const t = Math.max(0, Math.min(1, (T - 150) / (380 - 150)));
  let r: number, g: number, b: number;
  if (t < 0.5) {
    const s = t / 0.5;
    r = Math.round(cold.r + s * (neutral.r - cold.r));
    g = Math.round(cold.g + s * (neutral.g - cold.g));
    b = Math.round(cold.b + s * (neutral.b - cold.b));
  } else {
    const s = (t - 0.5) / 0.5;
    r = Math.round(neutral.r + s * (hot.r - neutral.r));
    g = Math.round(neutral.g + s * (hot.g - neutral.g));
    b = Math.round(neutral.b + s * (hot.b - neutral.b));
  }
  return `rgb(${r},${g},${b})`;
}

function useThermalColor(panelIndex: number, thermalEnabled: boolean): string {
  const [color, setColor] = React.useState<string>('#1e3f8a');
  const frameRef = React.useRef<number>(0);
  const startRef = React.useRef<number>(performance.now());

  React.useEffect(() => {
    if (!thermalEnabled) {
      setColor('#1e3f8a'); // reset to default panel blue
      return;
    }
    const orbitPeriod = 92 * 60 * 1000; // 92-minute LEO orbit in ms
    // Each panel is offset by its index (simulate different faces)
    const phaseOffset = (panelIndex / 4) * Math.PI * 2;

    function tick() {
      const elapsed = performance.now() - startRef.current;
      // Speed up by 500x so one orbit = ~11 seconds visually
      const t = ((elapsed * 500) % orbitPeriod) / orbitPeriod;
      const angle = t * Math.PI * 2 + phaseOffset;
      // Eclipse fraction: panel is in shadow ~35% of orbit
      const sunlit = Math.sin(angle) > -0.35 ? Math.sin(angle) : -0.35;
      // Temperature swings: 170 K in eclipse, 340 K in full sun
      const T = 255 + 85 * sunlit; // K
      setColor(kelvinToRGB(T));
      frameRef.current = requestAnimationFrame(tick);
    }

    frameRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameRef.current);
  }, [thermalEnabled, panelIndex]);

  return color;
}

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
  frameWidth,
  children,
  thermalColor,
  thermalEnabled,
  panelIndex,
}: {
  position: [number, number, number];
  rotation: [number, number, number];
  hingePosition: [number, number, number];
  hingeAxis: 'x' | 'y' | 'z';
  angle: number;
  size: [number, number, number]; // [length (x), totalThickness (y), depth (z)]
  index: number;
  stuck: boolean;
  wireframe: boolean;
  showLabel: boolean;
  onClick?: () => void;
  configColorIndex: number;
  frameWidth: number; // meters
  children?: React.ReactNode;
  /** When provided, overrides config colour with thermal-driven colour */
  thermalColor?: string;
  thermalEnabled?: boolean;
  panelIndex?: number;
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

  // Priority: stuck (red) > thermal colour > config colour
  const panelColor = stuck 
    ? '#ef4444' 
    : (thermalColor ?? CONFIG_COLORS[configColorIndex] ?? PANEL_CELL_COLOR);

  const thermalColorFromHook = useThermalColor(panelIndex ?? 0, thermalEnabled ?? false);
  const activePanelColor = (thermalEnabled && !stuck) ? thermalColorFromHook : panelColor;

  // Decompose sandwich panel
  const length = size[0];
  const totalTh = size[1];
  const depth = size[2];

  // Layer thicknesses (ratios of 2.5 mm total)
  const solarTh = totalTh * (0.2 / 2.5);   // 0.2 mm
  const coreTh = totalTh * (2.0 / 2.5);    // 2.0 mm
  const backTh = totalTh * (0.3 / 2.5);    // 0.3 mm

  // Compute layer centers so overall panel remains centered at Y=0
  let cursor = -totalTh / 2;
  const solarCenter = cursor + solarTh / 2; cursor += solarTh;
  const coreCenter = cursor + coreTh / 2; cursor += coreTh;
  const backCenter = cursor + backTh / 2; cursor += backTh;

  // Procedural solar-cell texture (grid) — memoized per panel instance
  const solarTexture = React.useMemo(() => {
    const sizePx = 512;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = sizePx;
    const ctx = canvas.getContext('2d')!;

    // base gradient color depends on configuration (double-long-edge -> purple)
    const baseColor = configColorIndex === 1 ? '#4a2a6a' : '#1a3a52';
    const secondary = configColorIndex === 1 ? '#2f1a3f' : '#0d2a4f';
    const g = ctx.createLinearGradient(0, 0, sizePx, sizePx);
    g.addColorStop(0, baseColor);
    g.addColorStop(1, secondary);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, sizePx, sizePx);

    // fine grid lines to simulate cell boundaries
    ctx.strokeStyle = 'rgba(255,255,255,0.06)';
    ctx.lineWidth = 2;
    const cols = 6; // visual cell columns
    const rows = 12; // visual cell rows
    for (let i = 1; i < cols; i++) {
      const x = (i * sizePx) / cols;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, sizePx);
      ctx.stroke();
    }
    for (let j = 1; j < rows; j++) {
      const y = (j * sizePx) / rows;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(sizePx, y);
      ctx.stroke();
    }

    // busbars (thicker vertical lines)
    ctx.strokeStyle = 'rgba(255,255,255,0.12)';
    ctx.lineWidth = 6;
    ctx.beginPath(); ctx.moveTo(sizePx * 0.18, 0); ctx.lineTo(sizePx * 0.18, sizePx); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(sizePx * 0.82, 0); ctx.lineTo(sizePx * 0.82, sizePx); ctx.stroke();

    const tex = new THREE.CanvasTexture(canvas);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.repeat.set(1, 1);
    tex.encoding = THREE.sRGBEncoding;
    return tex;
  }, []);

  // Dispose texture when unmounted
  React.useEffect(() => {
    return () => { solarTexture.dispose(); };
  }, [solarTexture]);

  return (
    <group position={hingePosition} rotation={rotation}>
      <group ref={groupRef}>
        <group position={position}>
          {/* Solar cell layer (top) */}
          <mesh position={[0, solarCenter, 0]} castShadow>
            <boxGeometry args={[length, solarTh, depth]} />
            <meshStandardMaterial
              map={thermalEnabled ? null : solarTexture}
              color={activePanelColor}
              emissive={thermalEnabled ? activePanelColor : '#000000'}
              emissiveIntensity={thermalEnabled ? 0.4 : 0}
              metalness={0.2}
              roughness={0.4}
            />
          </mesh>

          {/* Honeycomb core (middle) */}
          <mesh position={[0, coreCenter, 0]} castShadow>
            <boxGeometry args={[length * 0.98, coreTh, depth * 0.98]} />
            <meshStandardMaterial color="#c9ccd0" metalness={0.7} roughness={0.35} />
          </mesh>

          {/* Aluminum backing (bottom) */}
          <mesh position={[0, backCenter, 0]} castShadow>
            <boxGeometry args={[length, backTh, depth]} />
            <meshStandardMaterial
              color={thermalEnabled ? activePanelColor : '#a5a9ac'}
              emissive={thermalEnabled ? activePanelColor : '#000000'}
              emissiveIntensity={thermalEnabled ? 0.2 : 0}
              metalness={0.9}
              roughness={0.25}
            />
          </mesh>

          {/* Frame — four perimeter bars (width = frameWidth) */}
          {frameWidth > 0 && (
            <> 
              {/* left */}
              <mesh position={[ -length / 2 + frameWidth / 2, 0, 0 ]}>
                <boxGeometry args={[frameWidth, totalTh, depth]} />
                <meshStandardMaterial color="#6b6f73" metalness={0.9} roughness={0.35} />
              </mesh>
              {/* right */}
              <mesh position={[ length / 2 - frameWidth / 2, 0, 0 ]}>
                <boxGeometry args={[frameWidth, totalTh, depth]} />
                <meshStandardMaterial color="#6b6f73" metalness={0.9} roughness={0.35} />
              </mesh>
              {/* top */}
              <mesh position={[ 0, 0, -depth / 2 + frameWidth / 2 ]}>
                <boxGeometry args={[ length - frameWidth * 2, totalTh, frameWidth ]} />
                <meshStandardMaterial color="#6b6f73" metalness={0.9} roughness={0.35} />
              </mesh>
              {/* bottom */}
              <mesh position={[ 0, 0, depth / 2 - frameWidth / 2 ]}>
                <boxGeometry args={[ length - frameWidth * 2, totalTh, frameWidth ]} />
                <meshStandardMaterial color="#6b6f73" metalness={0.9} roughness={0.35} />
              </mesh>
            </>
          )}

          {showLabel && (
            <Text
              position={[0, totalTh * 0.6, 0]}
              fontSize={0.02}
              color={stuck ? '#ef4444' : '#ffffff'}
              anchorX="center"
              anchorY="middle"
            >
              {stuck ? `P${index + 1} STUCK` : `P${index + 1}`}
            </Text>
          )}


        </group>
        {/* Render child panels (hierarchical) inside the rotating group */}
        {children}
      </group>
    </group>
  );
}

// Fixed screen-space coordinate system widget (top-right corner)
// Shows global X (red), Y (green), Z (blue) axes to eliminate orientation ambiguity
// Coordinate system: X = right, Y = forward, Z = up
function TopRightAxesWidget({ visible, size }: { visible: boolean; size: number }) {
  const ref = useRef<THREE.Group | null>(null);
  const { camera } = useThree();

  useEffect(() => {
    if (!ref.current) return;
    camera.add(ref.current);
    // top-right offset in camera space
    ref.current.position.set(1.25 * size, 0.9 * size, -2.5);
    return () => { camera.remove(ref.current!); };
  }, [camera, size]);

  useFrame(() => {
    if (!ref.current) return;
    // Keep widget aligned to world axes while remaining camera-anchored
    ref.current.quaternion.copy(camera.quaternion.clone().invert());
    ref.current.visible = !!visible;
  });

  const axisLen = 0.12 * size;
  const shaftR = 0.006 * size;
  const headLen = 0.035 * size;
  const headR = 0.012 * size;
  const fontSize = 0.05 * size;

  return (
    <group ref={ref} renderOrder={999} name="TopRightAxesWidget">
      {/* X axis - red (right) */}
      <mesh position={[axisLen / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <cylinderGeometry args={[shaftR, shaftR, axisLen, 12]} />
        <meshStandardMaterial color="#ff3333" metalness={0.5} roughness={0.3} />
      </mesh>
      <mesh position={[axisLen + headLen / 2, 0, 0]} rotation={[0, 0, -Math.PI / 2]}>
        <coneGeometry args={[headR, headLen, 12]} />
        <meshStandardMaterial color="#ff3333" metalness={0.5} roughness={0.3} />
      </mesh>
      <Text position={[axisLen + headLen + 0.025 * size, 0, 0]} fontSize={fontSize} color="#ff3333" anchorX="left">X</Text>

      {/* Y axis - green (forward) */}
      <mesh position={[0, axisLen / 2, 0]}>
        <cylinderGeometry args={[shaftR, shaftR, axisLen, 12]} />
        <meshStandardMaterial color="#33ff33" metalness={0.5} roughness={0.3} />
      </mesh>
      <mesh position={[0, axisLen + headLen / 2, 0]}>
        <coneGeometry args={[headR, headLen, 12]} />
        <meshStandardMaterial color="#33ff33" metalness={0.5} roughness={0.3} />
      </mesh>
      <Text position={[0, axisLen + headLen + 0.025 * size, 0]} fontSize={fontSize} color="#33ff33" anchorX="center">Y</Text>

      {/* Z axis - blue (up) */}
      <mesh position={[0, 0, axisLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[shaftR, shaftR, axisLen, 12]} />
        <meshStandardMaterial color="#3333ff" metalness={0.5} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0, axisLen + headLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[headR, headLen, 12]} />
        <meshStandardMaterial color="#3333ff" metalness={0.5} roughness={0.3} />
      </mesh>
      <Text position={[0, 0, axisLen + headLen + 0.025 * size]} fontSize={fontSize} color="#3333ff" anchorX="center">Z</Text>
    </group>
  );
}

function OrientationWidget({ bodyOrientation, size }: { bodyOrientation: { x: number; y: number; z: number }; size: number }) {
  const ref = useRef<THREE.Group | null>(null);
  const { camera } = useThree();

  useEffect(() => {
    if (!ref.current) return;
    // attach to camera so widget stays fixed in screen space
    camera.add(ref.current);
    // bottom-left offset in camera space (tweak values for consistent placement)
    ref.current.position.set(-1.25 * size, -0.9 * size, -2.5);
    return () => { camera.remove(ref.current!); };
  }, [camera, size]);

  useFrame(() => {
    if (!ref.current) return;
    // bodyOrientation is world Euler; convert to quaternion and express relative to camera
    const bodyEuler = new THREE.Euler(bodyOrientation.x, bodyOrientation.y, bodyOrientation.z, 'XYZ');
    const qBody = new THREE.Quaternion().setFromEuler(bodyEuler);
    const qRel = camera.quaternion.clone().invert().multiply(qBody);
    ref.current.quaternion.copy(qRel);
  });

  const axisLen = 0.12 * size;
  const shaftR = 0.005 * size;
  const headLen = 0.03 * size;
  const headR = 0.01 * size;

  return (
    <group ref={ref} renderOrder={999} name="OrientationWidget">
      {/* X - red */}
      <mesh position={[axisLen / 2, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[shaftR, shaftR, axisLen, 8]} />
        <meshStandardMaterial color="#ff0000" metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh position={[axisLen + headLen / 2, 0, 0]} rotation={[0, 0, Math.PI / 2]}>
        <coneGeometry args={[headR, headLen, 8]} />
        <meshStandardMaterial color="#ff0000" metalness={0.6} roughness={0.3} />
      </mesh>

      {/* Y - green */}
      <mesh position={[0, axisLen / 2, 0]}>
        <cylinderGeometry args={[shaftR, shaftR, axisLen, 8]} />
        <meshStandardMaterial color="#00ff00" metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh position={[0, axisLen + headLen / 2, 0]}>
        <coneGeometry args={[headR, headLen, 8]} />
        <meshStandardMaterial color="#00ff00" metalness={0.6} roughness={0.3} />
      </mesh>

      {/* Z - blue */}
      <mesh position={[0, 0, axisLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[shaftR, shaftR, axisLen, 8]} />
        <meshStandardMaterial color="#0000ff" metalness={0.6} roughness={0.3} />
      </mesh>
      <mesh position={[0, 0, axisLen + headLen / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <coneGeometry args={[headR, headLen, 8]} />
        <meshStandardMaterial color="#0000ff" metalness={0.6} roughness={0.3} />
      </mesh>

      {/* Labels */}
      <Text position={[axisLen + headLen + 0.02 * size, 0, 0]} fontSize={0.04 * size} color="#ff0000">X</Text>
      <Text position={[0, axisLen + headLen + 0.02 * size, 0]} fontSize={0.04 * size} color="#00ff00">Y</Text>
      <Text position={[0, 0, axisLen + headLen + 0.02 * size]} fontSize={0.04 * size} color="#0000ff">Z</Text>
    </group>
  );
}

import { getPanelSpecs } from '@/lib/physics/panelLayouts';

interface PanelConfig {
  pos: [number, number, number];
  rot: [number, number, number];
  hinge: [number, number, number];
  axis: 'x' | 'y' | 'z';
  size: [number, number, number];
  parentIndex?: number;
  hingeOffset?: [number, number, number];
  stage?: 1 | 2 | 3;
  maxAngle?: number;
}

function getPanelConfigs(config: ConfigType, s: number, params: SimulationParams): PanelConfig[] {
  // Scene scale (keeps previous visual scaling behavior)
  const scale = s * 4; // 1 meter in params -> scale units in scene

  // Use centralized panel specs (meters) and convert to scene units here
  const specs = getPanelSpecs(config, params);

  return specs.map(spec => ({
    pos: [spec.pos[0] * scale, spec.pos[1] * scale, spec.pos[2] * scale] as [number, number, number],
    rot: spec.rot as [number, number, number],
    hinge: [spec.hinge[0] * scale, spec.hinge[1] * scale, spec.hinge[2] * scale] as [number, number, number],
    axis: spec.axis as 'x' | 'y' | 'z',
    size: [spec.size[0] * scale, spec.size[1] * scale, spec.size[2] * scale] as [number, number, number],
    parentIndex: spec.parentIndex,
    hingeOffset: spec.hingeOffset 
      ? [spec.hingeOffset[0] * scale, spec.hingeOffset[1] * scale, spec.hingeOffset[2] * scale] as [number, number, number]
      : undefined,
    stage: spec.stage,
    maxAngle: spec.maxAngle,
  }));
}

function CubeSatBody({ size, wireframe, showFaceLabels }: { size: [number, number, number]; wireframe: boolean; showFaceLabels?: boolean }) {
  const [sx, sy, sz] = size;
  const labelOffset = 0.02; // offset from face
  const fontSize = 0.06;
  
  return (
    <group>
      <mesh castShadow receiveShadow>
        <boxGeometry args={size} />
        <meshStandardMaterial
          color={BODY_COLOR}
          wireframe={wireframe}
          metalness={0.4}
          roughness={0.6}
        />
      </mesh>
      
      {/* Face labels for orientation reference */}
      {showFaceLabels && (
        <>
          {/* +X face (right) */}
          <Text position={[sx/2 + labelOffset, 0, 0]} rotation={[0, Math.PI/2, 0]} fontSize={fontSize} color="#ff6666" anchorX="center" anchorY="middle">+X</Text>
          {/* -X face (left) */}
          <Text position={[-sx/2 - labelOffset, 0, 0]} rotation={[0, -Math.PI/2, 0]} fontSize={fontSize} color="#ff6666" anchorX="center" anchorY="middle">-X</Text>
          {/* +Y face (front) */}
          <Text position={[0, sy/2 + labelOffset, 0]} rotation={[-Math.PI/2, 0, Math.PI]} fontSize={fontSize} color="#66ff66" anchorX="center" anchorY="middle">+Y</Text>
          {/* -Y face (back) */}
          <Text position={[0, -sy/2 - labelOffset, 0]} rotation={[Math.PI/2, 0, 0]} fontSize={fontSize} color="#66ff66" anchorX="center" anchorY="middle">-Y</Text>
          {/* +Z face (top) */}
          <Text position={[0, 0, sz/2 + labelOffset]} rotation={[0, 0, 0]} fontSize={fontSize} color="#6666ff" anchorX="center" anchorY="middle">+Z</Text>
          {/* -Z face (bottom) */}
          <Text position={[0, 0, -sz/2 - labelOffset]} rotation={[Math.PI, 0, 0]} fontSize={fontSize} color="#6666ff" anchorX="center" anchorY="middle">-Z</Text>
        </>
      )}
    </group>
  );
} 

function CubeSatScene({
  config,
  state,
  params = DEFAULT_PARAMS,
  showLabels = false,
  showAxes = true,
  wireframe = false,
  onPanelClick,
  size = 1,
  thermalEnabled = false,
  thermalState,
}: CubeSatModelProps) {
  const bodyRef = useRef<THREE.Group>(null);
  // Coordinate system: X = width (right), Y = depth (forward), Z = height (up)
  const bodySize = [params.bodyWidth * size * 4, params.bodyDepth * size * 4, params.bodyHeight * size * 4] as [number, number, number];

  const panelConfigs = useMemo(() => getPanelConfigs(config, size, params), [config, size, params]);
  const configIndex = ['long-edge', 'double-long-edge', 'short-edge', 'short-edge-long-edge'].indexOf(config);

  // Compute thermal colour if thermal effects are enabled
  const thermalColor = useMemo(() => {
    if (!thermalEnabled || !thermalState) return undefined;
    return getThermalColor(thermalState.currentTemperatureDeg);
  }, [thermalEnabled, thermalState?.currentTemperatureDeg]);

  useFrame(() => {
    if (!bodyRef.current) return;

    // Rotate the body about its true composite CoM, not its geometric centre.
    // Offsetting the group by -comBody × sceneScale keeps the CoM at the world
    // origin, about which the rotation naturally occurs. Scale matches bodySize.
    if (state.comBody) {
      const scale = size * 4;
      bodyRef.current.position.set(
        -state.comBody.x * scale,
        -state.comBody.y * scale,
        -state.comBody.z * scale,
      );
    }

    bodyRef.current.rotation.set(
      state.orientation.x,
      state.orientation.y,
      state.orientation.z,
    );
  });

  return (
    <group ref={bodyRef}>
      <CubeSatBody size={bodySize} wireframe={wireframe} showFaceLabels={showLabels} />

      {/* on-screen coordinate widget (bottom-left) — mirrors spacecraft orientation */}
      <OrientationWidget bodyOrientation={state.orientation} size={size} />

      {/* top-right screen coordinate system (world axes) — shows global X/Y/Z with labels */}
      {/** visible when `showAxes` is true (controlled from SimulationPage) */}
      <TopRightAxesWidget visible={showAxes} size={size} />

      {/* Visual hinge rods (metallic) — one per panel hinge line; non-rotating, flush with body */}
      {panelConfigs.map((pc, i) => {
        // Determine hinge rod orientation and length based on hinge axis
        // For long-edge config (axis='y'), the hinge runs along Z (full body height)
        // The hinge rod length should be the panel span dimension
        let rodRot: [number, number, number];
        let rodLen = pc.size[2]; // default: use panel span
        
        if (pc.axis === 'x') {
          // Hinge along X axis — length = body width (2 * bodyHalfWidth)
          rodRot = [0, 0, Math.PI / 2];
          rodLen = bodySize[0]; // body width in scene units
        } else if (pc.axis === 'z') {
          // Hinge along Z axis (vertical)
          rodRot = [Math.PI / 2, 0, 0];
        } else {
          // Hinge along Y axis (horizontal, front-to-back)
          // For side-mounted panels, rod runs along Y but panel span is in Z
          rodRot = [0, 0, 0];
          // Use body height for hinge rod length on side-mounted panels
          rodLen = bodySize[2]; // Z dimension (height)
        }
        
        return (
          <mesh
            key={`hinge-${i}`}
            position={pc.hinge}
            rotation={rodRot}
          >
            <cylinderGeometry args={[0.003 * size * 4, 0.003 * size * 4, rodLen, 16]} />
            <meshStandardMaterial color="#707070" metalness={0.9} roughness={0.25} />
          </mesh>
        );
      })}

      {panelConfigs.map((pc, i) => {
        // Skip child panels - they'll be rendered as children of their parent
        if (pc.parentIndex !== undefined) return null;
        
        // Find children of this panel
        const childPanels = panelConfigs
          .map((child, childIdx) => ({ ...child, idx: childIdx }))
          .filter(child => child.parentIndex === i);
        
        return (
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
            frameWidth={0.005 * size}
            thermalColor={thermalColor}
            thermalEnabled={thermalEnabled}
            panelIndex={i}
          >
            {/* Render child panels hierarchically */}
            {childPanels.map(child => (
              <SolarPanel
                key={child.idx}
                position={child.pos}
                rotation={child.rot}
                // Child hinge is at hingeOffset in parent's local frame (from parent's hinge)
                hingePosition={child.hingeOffset || child.hinge}
                hingeAxis={child.axis}
                // Same angle θ as parent for accordion fold
                angle={state.panels[child.idx]?.angle ?? 0}
                size={child.size}
                index={child.idx}
                stuck={state.panels[child.idx]?.stuck ?? false}
                wireframe={wireframe}
                showLabel={showLabels}
                onClick={() => onPanelClick?.(child.idx)}
                configColorIndex={configIndex}
                frameWidth={0.005 * size}
                thermalColor={thermalColor}
                thermalEnabled={thermalEnabled}
                panelIndex={child.idx}
              />
            ))}
          </SolarPanel>
        );
      })}
    </group>
  );
}

export default function CubeSatViewer(props: CubeSatModelProps) {
  const { config, state, params = DEFAULT_PARAMS, showCoM } = props;

  const comData = useMemo(() => {
    if (!showCoM) return null;
    return computeSystemCoM(state, config, params);
  }, [showCoM, state, config, params]);

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        camera={{ position: [1.5, 1.5, 1.5], fov: 45, up: [0, 0, 1] }}
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
          up={[0, 0, 1]}
        />
        {/* Grid on XY plane (Z is up) */}
        <gridHelper args={[4, 20, '#333333', '#222222']} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -0.8]} />

        {comData && (() => {
          const cx = comData.comWorld.x;
          const cy = comData.comWorld.y;
          const cz = comData.comWorld.z;

          const markerColor =
            comData.offsetMm < 2 ? '#22c55e'
            : comData.offsetMm < 10 ? '#f59e0b'
            : '#ef4444';

          // Axis arm half-length in metres (clearly visible at CubeSat scale)
          const ARM = 0.06;

          return (
            <group renderOrder={999}>

              {/* ── Solid core sphere — always on top ─────────────────────── */}
              <mesh position={[cx, cy, cz]} renderOrder={999}>
                <sphereGeometry args={[0.012, 16, 16]} />
                <meshBasicMaterial
                  color={markerColor}
                  depthTest={false}
                  transparent
                  opacity={1}
                />
              </mesh>

              {/* ── Outer glow halo — larger, semi-transparent ─────────────── */}
              <mesh position={[cx, cy, cz]} renderOrder={998}>
                <sphereGeometry args={[0.022, 16, 16]} />
                <meshBasicMaterial
                  color={markerColor}
                  depthTest={false}
                  transparent
                  opacity={0.18}
                />
              </mesh>

              {/* ── X-axis arm (red) ──────────────────────────────────────── */}
              <line>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    args={[new Float32Array([cx - ARM, cy, cz, cx + ARM, cy, cz]), 3]}
                  />
                </bufferGeometry>
                <lineBasicMaterial color="#ef4444" depthTest={false} linewidth={2} />
              </line>

              {/* ── Y-axis arm (green) ──────────────────────────────────────── */}
              <line>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    args={[new Float32Array([cx, cy - ARM, cz, cx, cy + ARM, cz]), 3]}
                  />
                </bufferGeometry>
                <lineBasicMaterial color="#22c55e" depthTest={false} linewidth={2} />
              </line>

              {/* ── Z-axis arm (blue) ──────────────────────────────────────── */}
              <line>
                <bufferGeometry>
                  <bufferAttribute
                    attach="attributes-position"
                    args={[new Float32Array([cx, cy, cz - ARM, cx, cy, cz + ARM]), 3]}
                  />
                </bufferGeometry>
                <lineBasicMaterial color="#3b82f6" depthTest={false} linewidth={2} />
              </line>

              {/* ── Equatorial ring around CoM ────────────────────────────── */}
              <mesh position={[cx, cy, cz]} renderOrder={998}>
                <ringGeometry args={[0.018, 0.024, 36]} />
                <meshBasicMaterial
                  color={markerColor}
                  depthTest={false}
                  side={2}
                  transparent
                  opacity={0.75}
                />
              </mesh>

              {/* ── Per-panel centre dots (small, always-on-top) ─────────── */}
              {comData.panelCentresWorld.map((pos, i) => (
                <mesh
                  key={`pcom-${i}`}
                  position={[pos.x, pos.y, pos.z]}
                  renderOrder={997}
                >
                  <sphereGeometry args={[0.007, 8, 8]} />
                  <meshBasicMaterial
                    color="#94a3b8"
                    depthTest={false}
                    transparent
                    opacity={0.8}
                  />
                </mesh>
              ))}

              {/* ── Dashed lines from each panel CoM to system CoM ─────────── */}
              {comData.panelCentresWorld.map((pos, i) => (
                <line key={`pcom-line-${i}`}>
                  <bufferGeometry>
                    <bufferAttribute
                      attach="attributes-position"
                      args={[
                        new Float32Array([pos.x, pos.y, pos.z, cx, cy, cz]),
                        3,
                      ]}
                    />
                  </bufferGeometry>
                  <lineBasicMaterial
                    color="#94a3b8"
                    depthTest={false}
                    transparent
                    opacity={0.35}
                  />
                </line>
              ))}

            </group>
          );
        })()}
      </Canvas>
      {showCoM && comData && (
        <div style={{
          position: 'absolute',
          top: 16,
          right: 16,
          background: 'rgba(0, 0, 0, 0.82)',
          border: `1px solid ${
            comData.offsetMm < 2 ? '#22c55e44'
            : comData.offsetMm < 10 ? '#f59e0b44'
            : '#ef444444'
          }`,
          borderRadius: 10,
          padding: '10px 14px',
          pointerEvents: 'none',
          minWidth: 176,
          boxShadow: `0 0 18px ${
            comData.offsetMm < 2 ? '#22c55e22'
            : comData.offsetMm < 10 ? '#f59e0b22'
            : '#ef444422'
          }`,
        }}>
          {/* Header row with colour dot */}
          <div style={{
            display: 'flex', alignItems: 'center', gap: 7,
            marginBottom: 8, fontSize: 11,
            color: '#aaa', fontWeight: 700,
            letterSpacing: '0.06em', textTransform: 'uppercase',
          }}>
            <div style={{
              width: 8, height: 8, borderRadius: '50%',
              background: comData.offsetMm < 2 ? '#22c55e'
                        : comData.offsetMm < 10 ? '#f59e0b'
                        : '#ef4444',
              flexShrink: 0,
              boxShadow: `0 0 6px ${
                comData.offsetMm < 2 ? '#22c55e'
                : comData.offsetMm < 10 ? '#f59e0b'
                : '#ef4444'
              }`,
            }} />
            Centre of Mass
          </div>

          {/* XYZ body-frame coordinates */}
          <div style={{
            fontFamily: 'monospace', fontSize: 12,
            lineHeight: 1.85, color: '#ccc',
          }}>
            {[
              { label: 'X', val: comData.comBody.x, color: '#f87171' },
              { label: 'Y', val: comData.comBody.y, color: '#4ade80' },
              { label: 'Z', val: comData.comBody.z, color: '#60a5fa' },
            ].map(({ label, val, color }) => (
              <div key={label} style={{ display: 'flex', justifyContent: 'space-between', gap: 16 }}>
                <span style={{ color }}>{label}:</span>
                <span style={{ color: '#fff', fontWeight: 600 }}>
                  {(val * 1000).toFixed(2)} mm
                </span>
              </div>
            ))}
          </div>

          {/* Offset severity row */}
          <div style={{
            marginTop: 8, paddingTop: 8,
            borderTop: '1px solid #2a2a2a',
            display: 'flex', justifyContent: 'space-between',
            alignItems: 'center',
          }}>
            <span style={{ fontSize: 11, color: '#888' }}>Offset:</span>
            <span style={{
              fontSize: 13, fontWeight: 800, fontFamily: 'monospace',
              color: comData.offsetMm < 2 ? '#22c55e'
                   : comData.offsetMm < 10 ? '#f59e0b'
                   : '#ef4444',
            }}>
              {comData.offsetMm.toFixed(2)} mm
            </span>
          </div>

          {/* Status label */}
          <div style={{
            marginTop: 6,
            fontSize: 10,
            textAlign: 'center',
            color: comData.offsetMm < 2 ? '#22c55e'
                 : comData.offsetMm < 10 ? '#f59e0b'
                 : '#ef4444',
            fontWeight: 600,
            letterSpacing: '0.05em',
            textTransform: 'uppercase',
          }}>
            {comData.offsetMm < 2 ? '● Nominal'
            : comData.offsetMm < 10 ? '⚠ Asymmetric'
            : '✕ Severe Offset'}
          </div>
        </div>
      )}
    </div>
  );
}
