# deployable-dynamics

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](src/)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](src/)
[![Three.js](https://img.shields.io/badge/Three.js-r3f-black?logo=threedotjs)](src/components/CubeSatViewer.tsx)
[![Vite](https://img.shields.io/badge/build-Vite-646cff?logo=vite)](vite.config.ts)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-38bdf8?logo=tailwindcss)](tailwind.config.ts)
[![Docker](https://img.shields.io/badge/docker-ready-2496ed?logo=docker)](Dockerfile)
[![Tests](https://img.shields.io/badge/tests-Playwright%20%2B%20Vitest-green?logo=playwright)](playwright.config.ts)

> A browser-based 3D simulator for studying how timing discrepancies between deployable solar panel hinges induce tumbling and attitude disturbances on a 3U CubeSat — complete with a scientific report export at the end of each simulation run.

## What It Does

Deployable Dynamics investigates how asynchronous hinge release affects spacecraft attitude. Each simulation run lets you choose a deployment strategy (panel arrangement) and a timing delta — the deliberate or accidental offset between individual hinge release times. The physics engine propagates the resulting angular momentum imbalance into the spacecraft body in real time, visualised as a tumbling 3D model in the browser. At the end of every run a comprehensive scientific report is generated, summarising angular velocity profiles, induced rotation rates, and an assessment of attitude recovery feasibility.

## Deployment Strategies

Four canonical panel arrangements are available, each producing a different tumbling signature under the same timing delta:

| Strategy | Panels | Peak angular velocity (one-stuck, δt = 5 ms, FR4) | Notes |
|---|---|---|---|
| **Long-edge** | 2 | 1.60 °/s | Symmetric along Z-axis; near-zero induced rotation when delta ≈ 0 |
| **Double long-edge** | 4 | 5.13 °/s | Two accordion assemblies; sequential release amplifies roll |
| **Short-edge** | 4 | 0.37 °/s | Asymmetric momentum transfer; strong pitch coupling |
| **Coupled** | 8 | 4.76 °/s | Four mixed assemblies; multi-axis tumbling for large deltas |

## Timing Delta Parameter

The key independent variable is the **timing delta** δt — the staggered release offset applied between successive hinges. δt is stored in seconds and displayed in ns, µs, or ms. A delta of 0 represents ideal synchronous deployment; increasing δt models hinge latch failures, burn-wire delay variance, or manufacturing tolerances. δt is a single scalar value set per run, with three presets: Ideal 0 ns, Nominal 250 µs, Worst-case 5 ms.

## Physics Engine

The engine (`src/lib/physics/engine.ts`) models each hinge as a torsional spring-damper. All torques are in N·m; angular quantities in radians.

- **Spring torque**: `τ = k · (θ_stop − θ)` — preloaded torsion spring driving deployment
- **Damping**: `τ_d = −c · dθ/dt` — viscous damping; underdamped, damping ratio ζ ≈ 0.80
- **Mechanical stop**: contact model (`k_stop`, `c_stop`) halts each panel at its configured stop angle, 90° or 180° depending on stage
- **Coulomb friction**: single constant-magnitude Coulomb term opposing the sign of the hinge rate
- **Attitude coupling**: panel angular momentum transferred to spacecraft body (conservation of angular momentum)
- **Timing offset injection**: each hinge release is delayed by `n × δt` where n is the hinge index

### Default Spacecraft Parameters (3U CubeSat)

| Parameter | Value |
|---|---|
| Body dimensions | 100 × 100 × 340.5 mm |
| Body mass | 4.0 kg |
| Panel mass | 0.032 kg (FR4 default); 0.020–0.050 kg across material presets |
| Panel thickness | 2.5 mm (sandwich) |
| Hinge spring constant | 7.729454 × 10⁻³ N·m/rad |
| Damping coefficient | 4.946851 × 10⁻³ N·m·s/rad |
| Deployment target angle | 90° base stop; staged configurations deploy outer panels to 180° |

## Scientific Report

After each simulation run the app generates a downloadable report containing:

- **Panel mass** — the material-dependent panel mass used for the run
- **Final hinge deflection angle** — the panel's final deployed angle
- **Average required detumbling torque τ_avg,detumble** — ADCS sizing torque derived from peak deployment-induced angular momentum
- **Time to 90% deployment (t₉₀)** — time to first reach 90% of the final deployed angle
- **Peak angular velocity** — the trajectory-maximum body angular velocity

## App Pages

- **Landing** — strategy selector and timing delta input
- **Simulation** — live 3D viewer with real-time attitude telemetry and hinge state overlay
- **Compare** — side-by-side multi-run comparison across strategies or δt values
- **Report** — full scientific report viewer with export to PDF/JSON

## Quickstart

> **Prerequisites**: Node.js ≥18 (local dev) or Docker.

### Local Development

```bash
git clone https://github.com/JuliusPinsker/deployable-dynamics.git
cd deployable-dynamics
npm install
npm run dev
```

Open [http://localhost:8080](http://localhost:8080).

### Docker

```bash
docker compose up
```

Served on `http://localhost:8080`.

## Tech Stack

| Layer | Technology |
|---|---|
| UI framework | React 18 + TypeScript |
| 3D rendering | Three.js via React Three Fiber + Drei |
| Styling | Tailwind CSS + shadcn/ui |
| Build | Vite |
| Testing | Vitest (unit) + Playwright (e2e) |
| Containerisation | Docker + Docker Compose |

## Project Structure

```
src/
├── components/
│   ├── CubeSatViewer.tsx      # Three.js 3D model, panels, orientation widgets
│   ├── TelemetryOverlay.tsx   # Live attitude telemetry HUD
│   ├── SiteHeader.tsx         # Shared page header/navigation
│   ├── DelayInput.tsx         # Shared δt control (Simulation + Compare)
│   └── NavLink.tsx            # Nav link helper
├── lib/physics/
│   ├── engine.ts              # Hinge dynamics + attitude integration (RK4)
│   ├── types.ts               # Simulation types + default parameters
│   ├── panelLayouts.ts        # Panel geometry per deployment configuration
│   ├── reportData.ts          # Report scenario matrix generation
│   ├── calibration.ts         # Hinge (k, c) calibration sweep
│   ├── translationalCoupling.ts # Translational/CoM coupling diagnostics
│   ├── linearAlgebra.ts       # Linear algebra helpers
│   ├── constants.ts           # Physical constants
│   ├── orbitalTorques.ts      # Gravity-gradient/SRP torque models (not integrated into the deployment sweep)
│   ├── detumbling.ts          # B-dot control law (not integrated into the deployment sweep)
│   └── index.ts                # Barrel re-export
└── pages/
    ├── LandingPage.tsx        # Strategy + delta configuration
    ├── SimulationPage.tsx     # Main simulation view
    ├── ComparePage.tsx        # Multi-run comparison
    ├── ReportPage.tsx         # Report export page
    ├── Index.tsx              # Routing entry
    └── NotFound.tsx           # 404 page
```

## License

MIT — see [LICENSE](LICENSE) if present.
