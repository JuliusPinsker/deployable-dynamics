

# CubeSat Solar Panel Deployable Simulation Platform

## Overview
An interactive research presentation platform comparing 4 types of CubeSat solar panel deployable configurations. Features a balanced mix of 3D animated visualization and quantitative data charts, with intermediate-fidelity rigid body dynamics running in the browser.

---

## Page 1: Landing / Overview
- Hero section introducing the platform and the research context
- Visual overview of all 4 configurations with thumbnail 3D previews
- Quick-nav cards to jump to individual configurations or the comparison view

## Page 2: Interactive 3D Simulation View
- **3D CubeSat model** (using Three.js / React Three Fiber) showing the selected configuration
- Animated panel deployment with spring-damper hinge physics (torsion spring torque, damping, mechanical stops with impact forces)
- **Configuration selector** to switch between all 4 types:
  1. Long-edge Deployable (2 panels, Z-axis)
  2. Double Long-edge Deployable (4 panels, accordion fold)
  3. Short-edge Deployable (4 independent panels)
  4. Short-edge + Long-edge Coupled (8 panels, 4 assemblies)
- **Controls panel**:
  - Deploy / Reset button
  - Deployment speed slider
  - Camera orbit controls
  - Toggle wireframe / panel labels
- **Live telemetry overlay**: angular velocity (ωx, ωy, ωz), deployment angle, contact forces
- Ability to simulate **partial deployment failures** (click a panel to "stick" it at current angle)

## Page 3: Parameter Tuning
- Adjustable simulation parameters:
  - Panel mass and dimensions
  - Spring constant and preload torque
  - Hinge friction coefficient
  - Mechanical stop angle (90°–120°)
- Real-time preview of how parameter changes affect deployment dynamics
- Preset buttons for typical CubeSat sizes (1U, 3U, 6U)

## Page 4: Side-by-Side Comparison Dashboard
- **Split-screen 3D views** showing 2 configurations deploying simultaneously
- **Comparison charts** (using Recharts):
  - Angular velocity over time for each axis
  - Peak angular acceleration bar chart across all 4 types
  - Impact force magnitude and duration
  - Deployment time comparison
  - Residual rotation rate after deployment
- Anomaly scenario selector (one panel stuck, two panels stuck, asymmetric failure)
- Exportable summary table of key metrics

## Page 5: Deployment Anomaly Explorer
- Select a configuration and introduce specific failure modes:
  - One panel stuck at 0°, 45°, or custom angle
  - Adjacent vs. opposite panel failures
  - Sequential vs. simultaneous deployment
- 3D visualization of the anomaly with resulting tumble
- Charts showing how tumbling severity varies with failure type

## Physics Engine (Browser-based)
- Rigid body dynamics with Euler's rotation equations
- Spring-damper model for each hinge joint (torque = -k·θ - c·θ̇)
- Contact/impact model when panels hit mechanical stops (stiff spring + high damping)
- Coupling between panel deployment and spacecraft body rotation (conservation of angular momentum)
- Runs at ~60fps with requestAnimationFrame integration

## Design & UX
- Clean, modern research-tool aesthetic with dark mode support
- Responsive layout (desktop-optimized, functional on tablet)
- Smooth transitions between configurations
- Color-coded configurations for easy identification in charts
- Tooltips explaining physics terms and parameters

