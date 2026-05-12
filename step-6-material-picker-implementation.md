---
title: Step 6 Material Picker Implementation
description: Plan to add material presets, pass panel mass through navigation, and surface the active material in telemetry.
author: GitHub Copilot
ms.date: 2026-05-12
ms.topic: how-to
keywords:
  * cubesat
  * materials
  * simulation
estimated_reading_time: 5
---

## Goal

Add a material picker on the landing page with three real CubeSat panel presets, pass the selected panel mass into the simulation, and display the active material in telemetry. Update the default panel mass to a realistic value.

## Scope

* [src/lib/physics/types.ts](src/lib/physics/types.ts)
* [src/pages/LandingPage.tsx](src/pages/LandingPage.tsx)
* [src/pages/SimulationPage.tsx](src/pages/SimulationPage.tsx)
* [src/components/TelemetryOverlay.tsx](src/components/TelemetryOverlay.tsx)

## Required changes

* Update `DEFAULT_PARAMS.panelMass` from `0.3` to `0.032` with a comment for the FR4 preset.
* Add `MaterialPresetKey`, `MaterialPreset`, and `MATERIAL_PRESETS` near `DEFAULT_PARAMS`.
* Add a material picker UI on the landing page using the three presets.
* Pass `panelMass` via navigation state when routing to the simulation.
* Read `panelMass` from navigation state in the simulation page and merge it into params.
* Derive a `materialLabel` from `panelMass` and pass it to `TelemetryOverlay`.
* Add a read only telemetry row showing the active panel material label.

## Implementation steps

* [x] Update `DEFAULT_PARAMS.panelMass` to `0.032` with the FR4 comment.
* [x] Add the material preset types and `MATERIAL_PRESETS` array.
* [x] Add landing page state for the selected material, compute the active preset, and render the radio card group.
* [x] Locate the existing navigation logic on the landing page and pass `panelMass` in `navigate('/simulate', { state: { panelMass } })`.
* [x] Read `panelMass` from navigation state in the simulation page and apply it in the params `useMemo`.
* [x] Derive `materialLabel` from the preset list and pass it to `TelemetryOverlay`.
* [x] Add a telemetry row labeled "Panel material" with the new prop.

## Data to capture

* Capture the line where the landing page navigates to the simulation route before editing.
* Record any TypeScript errors or test failures, and update expected values if needed.

## Verification

```bash
docker compose run --rm app npx tsc --noEmit
```

```bash
docker compose run --rm app npm run test -- src/test/engine.test.ts
```

## Notes

The panel mass change is a 10x reduction. Engine tests that assert `eDetumble` or angular velocity magnitudes may need updated expected values.
