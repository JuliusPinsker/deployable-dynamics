---
title: Physics Engine Refactoring Plan
description: Phase-based migration from in-house physics math to stable pre-built library usage with rollback-safe guardrails
author: Copilot
ms.date: 2026-03-24
ms.topic: how-to
keywords:
    - cubesat
    - physics
    - three.js
    - orbital dynamics
estimated_reading_time: 6
---

## Overview
This document outlines the strategy to refactor the custom, hardcoded mathematical and physics functions in the `deployable-dynamics` project. The goal is to safely shift towards pre-built libraries without introducing numerical instability, ESM import errors, or test-breaking changes that caused previous rollbacks.

## The Blockers (Lessons from Previous Rollbacks)
1. **`gl-matrix` uses Float32Array by Default:** 32-bit floats cause significant precision loss for orbital mechanics (e.g., gravity gradient torques at ~1e-6 N·m). We must maintain 64-bit precision.
2. **`satellite.js` ESM Compatibility:** Its constants are not exposed as named ESM exports, leading to Vite build/runtime failures when attempting `import { mu } from 'satellite.js'`.
3. **`odex` Lacks Types & Breaks Determinism:** Adaptive step sizing changes simulation frame snapshots, which breaks existing hardcoded `Vitest` numerical assertions.
4. **Scope Creep:** Over-relying on `satellite.js` for simple orbital math like `meanMotion` introduces TLE dependencies prematurely.

---

## Refactoring Strategy

### Phase 1: THREE.js Integration (Zero New Dependencies, Zero Risk) ✅
Leverage the existing `three` package (already used by `@react-three/fiber`) to handle all 64-bit Vector and Quaternion algebra.

*   **Action Items:**
    *   Replace all `Vector3` and `Quaternion` interfaces in `src/lib/physics/types.ts` with `import { Vector3, Quaternion } from 'three'`.
    *   Remove all manual `v3*` (e.g., cross, dot, add) and `q*` helpers from `engine.ts` and `orbitalTorques.ts`.
    *   Replace custom array implementations with native `THREE.Vector3` and `THREE.Quaternion` methods.
    *   Replace `Math.max(-1, Math.min(1, x))` with `THREE.MathUtils.clamp`.
    *   Replace manual angle conversions with `THREE.MathUtils.radToDeg` and `degToRad`.
    *   Replace Rodrigues rotation in `updateNadirVector` with `new THREE.Quaternion().setFromAxisAngle(...).applyQuaternion(...)`.

*   **Implemented in code:**
    *   Migrated vector/quaternion operation internals in `engine.ts` and `orbitalTorques.ts` to `THREE.Vector3`, `THREE.Quaternion`, and `THREE.Euler`.
    *   Replaced the explicit Rodrigues implementation in `updateNadirVector` with quaternion axis-angle rotation via `three`.
    *   Updated `types.ts` vector and quaternion definitions to derive from `three` types while preserving current object-shape compatibility.

### Phase 2: Standardized `constants.ts` (No New Packages) ✅
Instead of using `satellite.js` or `mathjs` for constants, implement a mathematically rigorous, fully cited constants file.

*   **Action Items:**
    *   Create `src/lib/physics/constants.ts`.
    *   Migrate constants like `GM_EARTH`, `R_EARTH`, `P_SOLAR`, etc., from `orbitalTorques.ts` or other files.
    *   Source values directly from IERS 2010, WGS-84, and CODATA 2018.
    *   Include detailed JSDoc comments with the standard, year, and units for every exported constant.

*   **Implemented in code:**
    *   Added `src/lib/physics/constants.ts` with standardized constants and source metadata comments.
    *   Updated `engine.ts` and `orbitalTorques.ts` to use centralized constants.
    *   Kept compatibility exports in `orbitalTorques.ts` so existing tests and callers remain stable.

### Phase 3: `satellite.js` for SGP4 Only (Scoped, Optional) ⚠️
*Do not use this to replace simple deterministic equations.*
*   **Action Items:**
    *   Only introduce if true SGP4/SDP4 TLE-based propagation is required as a new product feature.
    *   Wrap in a try/catch ESM import shim.
    *   Test in absolute isolation before integrating into the main physics loop.

### Phase 4: `odex` for Adaptive RK45 (Deferred, High Risk) ❌
*Skip until Phases 1–3 are fully stable and tested.*
*   **Action Items:**
    *   Current fixed-step RK4 + conservation correction works well for the timescales simulated.
    *   If adaptive step sizes become necessary due to numerical explosion from "stiff" thermal/flex models, a `declare module 'odex'` shim must be created first.
    *   Requires a full test-suite refactor since simulation frames will no longer match the exact 1/60s ticks expected by `Vitest`.

---

## Status
* [x] Phase 1: Complete
* [x] Phase 2: Complete
* [ ] Phase 3: Deferred
* [ ] Phase 4: Deferred

## Validation Log
* Phase 1 tests passed: `docker compose run --rm app npm run test -- src/test/engine.test.ts src/test/orbitalTorques.test.ts src/test/rk4.test.ts src/test/angularMomentum.test.ts`
* Phase 2 tests passed: `docker compose run --rm app npm run test -- src/test/engine.test.ts src/test/orbitalTorques.test.ts src/test/rk4.test.ts src/test/angularMomentum.test.ts`
