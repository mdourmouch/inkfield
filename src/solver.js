// Jos Stam's stable fluids, with no DOM in sight: inkfield.js renders this, bench/step.mjs
// times it under node. Grid coordinates throughout -- pixels are the renderer's problem.
//
// `params` is read live every frame, so a slider bound to it takes effect on the next step.
export function createSolver(cols, rows, params) {
  const N = cols * rows;
  const u = new Float32Array(N), v = new Float32Array(N);
  const u_prev = new Float32Array(N), v_prev = new Float32Array(N);
  const density = new Float32Array(N), density_prev = new Float32Array(N);
  const pressure = new Float32Array(N), divergence = new Float32Array(N);

  // Only inject/burst index from arbitrary offsets, so only they pay for the clamp.
  function IX(x, y) {
    x = Math.max(0, Math.min(cols - 1, x));
    y = Math.max(0, Math.min(rows - 1, y));
    return x + y * cols;
  }

  // Interior loops never leave the grid, so a clamp on every access was dead work.
  // Neighbours are idx±1 (same row) and idx±cols (row above/below). bench/step.mjs asserts
  // this produces a bit-identical field to the clamped reference.
  function setBnd(b, x) {
    const top = 0, top1 = cols, bot = (rows - 1) * cols, bot1 = (rows - 2) * cols;
    for (let i = 1; i < cols - 1; i++) {
      x[top + i] = b === 2 ? -x[top1 + i] : x[top1 + i];
      x[bot + i] = b === 2 ? -x[bot1 + i] : x[bot1 + i];
    }
    for (let j = 1, r = cols; j < rows - 1; j++, r += cols) {
      x[r] = b === 1 ? -x[r + 1] : x[r + 1];
      x[r + cols - 1] = b === 1 ? -x[r + cols - 2] : x[r + cols - 2];
    }
  }

  function linSolve(b, x, x0, a, c) {
    const cRecip = 1.0 / c;
    for (let k = 0; k < params.iterations; k++) {
      for (let j = 1; j < rows - 1; j++) {
        const r = j * cols;
        for (let idx = r + 1, end = r + cols - 1; idx < end; idx++) {
          x[idx] = (x0[idx] + a * (x[idx + 1] + x[idx - 1] + x[idx + cols] + x[idx - cols])) * cRecip;
        }
      }
      setBnd(b, x);
    }
  }

  function diffuse(b, x, x0, diff, dt) {
    // diffuse() is 3 of step()'s 5 linSolve calls -- 60% of the solver. At zero diffusion
    // the solve converges to a copy, so skip the sweeps and copy directly. x0 already
    // carries valid boundaries from the operation that produced it. Raise viscosity or
    // diffusion and the solver runs again, paying for the blur only when it was asked for.
    if (diff <= 0) { x.set(x0); return; }
    const a = dt * diff * (cols - 2) * (rows - 2);
    linSolve(b, x, x0, a, 1 + 4 * a);
  }

  function advect(b, d, d0, u, v, dt) {
    const dt0 = dt * (cols - 2);
    const xMax = cols - 1.5, yMax = rows - 1.5;
    for (let j = 1; j < rows - 1; j++) {
      const r = j * cols;
      for (let i = 1; i < cols - 1; i++) {
        const idx = r + i;
        let x = i - dt0 * u[idx];
        let y = j - dt0 * v[idx];
        if (x < 0.5) x = 0.5; else if (x > xMax) x = xMax;
        if (y < 0.5) y = 0.5; else if (y > yMax) y = yMax;
        const i0 = x | 0, j0 = y | 0;
        const s1 = x - i0, s0 = 1.0 - s1;
        const t1 = y - j0, t0 = 1.0 - t1;
        const a0 = j0 * cols + i0, a1 = a0 + cols;
        d[idx] = s0 * (t0 * d0[a0] + t1 * d0[a1]) + s1 * (t0 * d0[a0 + 1] + t1 * d0[a1 + 1]);
      }
    }
    setBnd(b, d);
  }

  function project(u, v, p, div) {
    const inv = -0.5 / Math.max(cols, rows);
    for (let j = 1; j < rows - 1; j++) {
      const r = j * cols;
      for (let idx = r + 1, end = r + cols - 1; idx < end; idx++) {
        div[idx] = inv * (u[idx + 1] - u[idx - 1] + v[idx + cols] - v[idx - cols]);
        p[idx] = 0;
      }
    }
    setBnd(0, div);
    setBnd(0, p);
    linSolve(0, p, div, 1, 4);

    for (let j = 1; j < rows - 1; j++) {
      const r = j * cols;
      for (let idx = r + 1, end = r + cols - 1; idx < end; idx++) {
        u[idx] -= 0.5 * (p[idx + 1] - p[idx - 1]) * cols;
        v[idx] -= 0.5 * (p[idx + cols] - p[idx - cols]) * rows;
      }
    }
    setBnd(1, u);
    setBnd(2, v);
  }

  const MAX_DENSITY = 5.0;

  // Uniform blob of ink, optionally carrying the pointer's momentum.
  function inject(gx, gy, r, amount, forceX = 0, forceY = 0) {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y <= r * r) {
          const idx = IX(gx + x, gy + y);
          density[idx] = Math.min(density[idx] + amount, MAX_DENSITY);
          u[idx] += forceX;
          v[idx] += forceY;
        }
      }
    }
  }

  // Same blob, but the velocity points outward and falls off with distance.
  function burst(gx, gy, r, amount, force) {
    for (let y = -r; y <= r; y++) {
      for (let x = -r; x <= r; x++) {
        const distSq = x * x + y * y;
        if (distSq <= r * r && distSq > 0) {
          const idx = IX(gx + x, gy + y);
          const dist = Math.sqrt(distSq);
          const f = (1 - dist / r) * force;
          u[idx] += (x / dist) * f;
          v[idx] += (y / dist) * f;
          density[idx] = Math.min(density[idx] + amount, MAX_DENSITY);
        }
      }
    }
  }

  function step() {
    const dt = params.dt;
    diffuse(1, u_prev, u, params.viscosity, dt);
    diffuse(2, v_prev, v, params.viscosity, dt);
    project(u_prev, v_prev, pressure, divergence);
    advect(1, u, u_prev, u_prev, v_prev, dt);
    advect(2, v, v_prev, u_prev, v_prev, dt);
    project(u, v, pressure, divergence);

    diffuse(0, density_prev, density, params.diffusion, dt);
    advect(0, density, density_prev, u, v, dt);

    const diss = params.dissipation, damp = params.velocityDamping;
    for (let i = 0; i < N; i++) {
      density[i] *= diss;
      u[i] *= damp;
      v[i] *= damp;
    }
  }

  // diffuse/advect/project are exported field-agnostic so bench/step.mjs can drive them
  // against its own arrays and diff the result with the reference implementation.
  return { cols, rows, N, u, v, density, step, inject, burst, diffuse, advect, project };
}
