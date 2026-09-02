# inkfield

A Jos Stam stable-fluids simulation rendered as drifting ASCII glyphs on a dark ground.

## The effect

Every frame solves incompressible fluid motion on a grid — advect, project, damp — then
maps each cell to one of four glyphs (`' ' _ < o`) by density plus velocity magnitude.
Ink is pushed by the pointer, dissipates as it spreads, and shifts hue with intensity.
The result reads as smoke or ink in water, drawn in text.

- **Move** the pointer to trail ink along the flow.
- **Click** for a radial burst.
- **B** runs an 8s automated stress benchmark, **H** toggles the HUD.

## Files

| | |
|---|---|
| `inkfield-optimized-monitored.html` | WebGL2 instanced renderer, glyph atlas, reduced solver. Open this one. |
| `inkfield-monitored.html` | Unoptimised Canvas2D original, kept as the A/B control. |
| `bench-step.mjs` | `node bench-step.mjs` — asserts the shipped solver stays bit-identical to the reference. |

## URL flags

`#tune` Tweakpane controls · `#bench` autostart benchmark · `#2d` force Canvas2D · `#dpr1` force 1x pixel density

Combine them in one hash (`#2d-bench`).
