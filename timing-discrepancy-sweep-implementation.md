---
title: Timing Discrepancy Sweep Implementation
description: Implementation outline for timing discrepancy controls, telemetry, and tests.
author: GitHub Copilot
ms.date: 2026-05-06
ms.topic: implementation
keywords:
  - timing discrepancy
  - delay sweep
  - simulation
estimated_reading_time: 3
---

## Goals

* Add timing discrepancy input, unit toggle, and presets in the Simulation page
* Surface the active delay value in the telemetry overlay
* Verify nonzero delay changes the simulation trajectory

## Scope

* Update SimulationPage controls and parameter wiring for short-edge delays
* Update TelemetryOverlay props and display row for the delay readout
* Add a simulation test covering delayed versus ideal deployment

## Implementation steps

* Add delay magnitude and unit state, and map to the 4-element delay tuple
* Wire delay into `shortEdgeStartDelays` in the simulation params
* Add the Timing Discrepancy input, unit toggle, and preset buttons to the controls card
* Pass delay props to TelemetryOverlay and render the read-only row
* Update TelemetryOverlay tests to pass the new props
* Add the delay trajectory test in simulate.test.ts

## Verification

* Run `docker compose run --rm app npx tsc --noEmit`
* Run `docker compose run --rm app npm run test -- src/test/simulate.test.ts`
* Manually verify preset and input behavior in the Simulation page
