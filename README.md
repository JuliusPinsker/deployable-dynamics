# deployable-dynamics

[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)](src/)
[![React](https://img.shields.io/badge/React-18-61dafb?logo=react)](src/)
[![Three.js](https://img.shields.io/badge/Three.js-r3f-black?logo=threedotjs)](src/components/CubeSatViewer.tsx)
[![Vite](https://img.shields.io/badge/build-Vite-646cff?logo=vite)](vite.config.ts)
[![Tailwind CSS](https://img.shields.io/badge/Tailwind-CSS-38bdf8?logo=tailwindcss)](tailwind.config.ts)
[![Docker](https://img.shields.io/badge/docker-ready-2496ed?logo=docker)](Dockerfile)
[![Tests](https://img.shields.io/badge/tests-Playwright%20%2B%20Vitest-green?logo=playwright)](playwright.config.ts)

> An interactive 3D web simulator for CubeSat solar panel deployment dynamics. Visualise hinge physics, spacecraft attitude disturbances, and thermal effects across four canonical deployable configurations — all in the browser.

## What It Does

Deployable Dynamics models the rigid-body rotational dynamics of a 3U CubeSat during solar panel deployment. A physics engine integrates hinge spring-damper equations and propagates attitude disturbances to the spacecraft body in real time. A React Three Fiber 3D viewer renders the satellite with sandwich-panel geometry, configurable hinge rods, and live orientation widgets.

## Deployable Configurations

| Config | Panels | Description |
|---|---|---|
| **Long-edge** | 2 | Two 3U panels along the Z-axis; symmetrical — minimal induced rotation |
| **Double long-edge** | 4 | Two accordion-fold assemblies along long edges; complex sequential dynamics |
| **Short-edge** | 4 | Four panels on short edges; high tumbling risk if deployment is asynchronous |
| **Coupled** | 8 | Eight panels in four assemblies combining both attachment types; highest complexity |

## Physics Engine

The engine (`src/lib/physics/engine.ts`) models each hinge as a torsional spring-damper. All torque values are in N·m and angular quantities in radians unless noted otherwise.

- **Spring torque**: `τ = k · (θ_stop − θ)` — preloaded torsion spring driving deployment
- **Damping**: `τ_d = −c · dθ/dt` — viscous damping, tuned for overdamped (~2 s) deployment
- **Mechanical stop**: rotational contact model (`k_stop`, `c_stop`) prevents overshoot
- **Coulomb friction**: small static friction term on each hinge
- **Attitude coupling**: panel angular momentum transfers to spacecraft body via conservation of angular momentum
- **Thermal model** (`thermalModel.ts`): optional panel temperature simulation affecting hinge behaviour
- **Kinematic mode**: optional deterministic ease-out profile for precise animation timing

### Default Spacecraft (3U CubeSat)

| Parameter | Value |
|---|---|
| Body dimensions | 100 × 100 × 340.5 mm |
| Body mass | 4.0 kg |
| Panel mass | 0.3 kg each |
| Panel thickness | 2.5 mm (sandwich) |
| Hinge spring constant | 0.02 N·m/rad |
| Damping coefficient | 0.08 N·m·s/rad |
| Deployment target | 90° (π/2 rad) |
| Default deploy duration | ~2.0 s |

## App Pages

- **Landing** — project overview and configuration selector
- **Simulation** — full 3D viewer with real-time physics, telemetry overlay, and parameter controls
- **Compare** — side-by-side comparison of multiple deployment configurations

## Quickstart

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

The app is served on port `8080` inside the container and mapped to `http://localhost:8080` on your host.

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
│   ├── CubeSatViewer.tsx   # Three.js 3D model, panels, orientation widgets
│   └── TelemetryOverlay.tsx # Live simulation telemetry HUD
├── lib/physics/
│   ├── engine.ts           # Hinge dynamics + attitude integration
│   ├── panelLayouts.ts     # Panel geometry per configuration
│   ├── thermalModel.ts     # Optional thermal state model
│   └── types.ts            # Simulation types + default parameters
└── pages/
    ├── SimulationPage.tsx  # Main simulation view + controls
    ├── ComparePage.tsx     # Multi-config comparison view
    └── LandingPage.tsx     # Entry page
```

## License

MIT — see [LICENSE](LICENSE) if present.
