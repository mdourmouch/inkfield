// Isolates the sim core from the DOM so step() cost is measurable without a browser.
// Proves/disproves the single biggest claim: clamped IX() in the hot loops is the bottleneck.
const cols = +(process.env.C||137), rows = +(process.env.R||61), N = cols * rows;   // 1920x1080 @ cellSize 14
const ITER = 4, DT = 0.15, VISC = 0.00001, DIFF = 0.00001, DISS = 0.997, VDAMP = 0.96;

const mk = () => Array.from({ length: 8 }, () => new Float32Array(N));

function seed(f) {
  // deterministic: same field for both variants
  const [u, v, , , density] = f;
  let s = 12345;
  const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let i = 0; i < N; i++) { density[i] = rnd() * 2; u[i] = rnd() - 0.5; v[i] = rnd() - 0.5; }
}

// ---------- variant A: current code (clamped IX everywhere) ----------
function makeA() {
  const IX = (x, y) => Math.max(0, Math.min(cols - 1, x)) + Math.max(0, Math.min(rows - 1, y)) * cols;
  function setBnd(b, x) {
    for (let i = 1; i < cols - 1; i++) {
      x[IX(i, 0)] = b === 2 ? -x[IX(i, 1)] : x[IX(i, 1)];
      x[IX(i, rows - 1)] = b === 2 ? -x[IX(i, rows - 2)] : x[IX(i, rows - 2)];
    }
    for (let j = 1; j < rows - 1; j++) {
      x[IX(0, j)] = b === 1 ? -x[IX(1, j)] : x[IX(1, j)];
      x[IX(cols - 1, j)] = b === 1 ? -x[IX(cols - 2, j)] : x[IX(cols - 2, j)];
    }
  }
  function linSolve(b, x, x0, a, c) {
    const cRecip = 1 / c;
    for (let k = 0; k < ITER; k++) {
      for (let j = 1; j < rows - 1; j++)
        for (let i = 1; i < cols - 1; i++)
          x[IX(i, j)] = (x0[IX(i, j)] + a * (x[IX(i + 1, j)] + x[IX(i - 1, j)] + x[IX(i, j + 1)] + x[IX(i, j - 1)])) * cRecip;
      setBnd(b, x);
    }
  }
  function diffuse(b, x, x0, diff, dt) { const a = dt * diff * (cols - 2) * (rows - 2); linSolve(b, x, x0, a, 1 + 4 * a); }
  function advect(b, d, d0, u, v, dt) {
    const dt0 = dt * (cols - 2);
    for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
      let x = i - dt0 * u[IX(i, j)], y = j - dt0 * v[IX(i, j)];
      if (x < 0.5) x = 0.5; if (x > cols - 1.5) x = cols - 1.5;
      const i0 = Math.floor(x), i1 = i0 + 1;
      if (y < 0.5) y = 0.5; if (y > rows - 1.5) y = rows - 1.5;
      const j0 = Math.floor(y), j1 = j0 + 1;
      const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
      d[IX(i, j)] = s0 * (t0 * d0[IX(i0, j0)] + t1 * d0[IX(i0, j1)]) + s1 * (t0 * d0[IX(i1, j0)] + t1 * d0[IX(i1, j1)]);
    }
    setBnd(b, d);
  }
  function project(u, v, p, div) {
    const m = Math.max(cols, rows);
    for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
      div[IX(i, j)] = -0.5 * (u[IX(i + 1, j)] - u[IX(i - 1, j)] + v[IX(i, j + 1)] - v[IX(i, j - 1)]) / m;
      p[IX(i, j)] = 0;
    }
    setBnd(0, div); setBnd(0, p); linSolve(0, p, div, 1, 4);
    for (let j = 1; j < rows - 1; j++) for (let i = 1; i < cols - 1; i++) {
      u[IX(i, j)] -= 0.5 * (p[IX(i + 1, j)] - p[IX(i - 1, j)]) * cols;
      v[IX(i, j)] -= 0.5 * (p[IX(i, j + 1)] - p[IX(i, j - 1)]) * rows;
    }
    setBnd(1, u); setBnd(2, v);
  }
  return (f) => {
    const [u, v, u_prev, v_prev, density, density_prev, pressure, divergence] = f;
    diffuse(1, u_prev, u, VISC, DT); diffuse(2, v_prev, v, VISC, DT);
    project(u_prev, v_prev, pressure, divergence);
    advect(1, u, u_prev, u_prev, v_prev, DT); advect(2, v, v_prev, u_prev, v_prev, DT);
    project(u, v, pressure, divergence);
    diffuse(0, density_prev, density, DIFF, DT); advect(0, density, density_prev, u, v, DT);
    for (let i = 0; i < N; i++) { density[i] *= DISS; u[i] *= VDAMP; v[i] *= VDAMP; }
  };
}

// ---------- variant B: flat running indices, no clamp in interior ----------
function makeB() {
  function setBnd(b, x) {
    const top = 0, bot = (rows - 1) * cols, top1 = cols, bot1 = (rows - 2) * cols;
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
    const cRecip = 1 / c;
    for (let k = 0; k < ITER; k++) {
      for (let j = 1; j < rows - 1; j++) {
        const r = j * cols;
        for (let idx = r + 1, end = r + cols - 1; idx < end; idx++)
          x[idx] = (x0[idx] + a * (x[idx + 1] + x[idx - 1] + x[idx + cols] + x[idx - cols])) * cRecip;
      }
      setBnd(b, x);
    }
  }
  function diffuse(b, x, x0, diff, dt) { const a = dt * diff * (cols - 2) * (rows - 2); linSolve(b, x, x0, a, 1 + 4 * a); }
  function advect(b, d, d0, u, v, dt) {
    const dt0 = dt * (cols - 2), xMax = cols - 1.5, yMax = rows - 1.5;
    for (let j = 1; j < rows - 1; j++) {
      const r = j * cols;
      for (let i = 1; i < cols - 1; i++) {
        const idx = r + i;
        let x = i - dt0 * u[idx], y = j - dt0 * v[idx];
        if (x < 0.5) x = 0.5; else if (x > xMax) x = xMax;
        if (y < 0.5) y = 0.5; else if (y > yMax) y = yMax;
        const i0 = x | 0, j0 = y | 0;
        const s1 = x - i0, s0 = 1 - s1, t1 = y - j0, t0 = 1 - t1;
        const a0 = j0 * cols + i0, a1 = a0 + cols;
        d[idx] = s0 * (t0 * d0[a0] + t1 * d0[a1]) + s1 * (t0 * d0[a0 + 1] + t1 * d0[a1 + 1]);
      }
    }
    setBnd(b, d);
  }
  function project(u, v, p, div) {
    const m = Math.max(cols, rows), inv = -0.5 / m;
    for (let j = 1; j < rows - 1; j++) {
      const r = j * cols;
      for (let idx = r + 1, end = r + cols - 1; idx < end; idx++) {
        div[idx] = inv * (u[idx + 1] - u[idx - 1] + v[idx + cols] - v[idx - cols]);
        p[idx] = 0;
      }
    }
    setBnd(0, div); setBnd(0, p); linSolve(0, p, div, 1, 4);
    for (let j = 1; j < rows - 1; j++) {
      const r = j * cols;
      for (let idx = r + 1, end = r + cols - 1; idx < end; idx++) {
        u[idx] -= 0.5 * (p[idx + 1] - p[idx - 1]) * cols;
        v[idx] -= 0.5 * (p[idx + cols] - p[idx - cols]) * rows;
      }
    }
    setBnd(1, u); setBnd(2, v);
  }
  return (f) => {
    const [u, v, u_prev, v_prev, density, density_prev, pressure, divergence] = f;
    diffuse(1, u_prev, u, VISC, DT); diffuse(2, v_prev, v, VISC, DT);
    project(u_prev, v_prev, pressure, divergence);
    advect(1, u, u_prev, u_prev, v_prev, DT); advect(2, v, v_prev, u_prev, v_prev, DT);
    project(u, v, pressure, divergence);
    diffuse(0, density_prev, density, DIFF, DT); advect(0, density, density_prev, u, v, DT);
    for (let i = 0; i < N; i++) { density[i] *= DISS; u[i] *= VDAMP; v[i] *= VDAMP; }
  };
}

function run(make, frames) {
  const step = make(), f = mk(); seed(f);
  for (let i = 0; i < 20; i++) step(f);          // warmup / JIT
  const t = performance.now();
  for (let i = 0; i < frames; i++) step(f);
  return { ms: (performance.now() - t) / frames, f };
}

const A = run(makeA, 300), B = run(makeB, 300);

// same math => same field. If this fires, variant B changed behaviour.
let maxDiff = 0;
for (let k = 0; k < 6; k++)
  for (let i = 0; i < N; i++) maxDiff = Math.max(maxDiff, Math.abs(A.f[k][i] - B.f[k][i]));
console.assert(maxDiff === 0, `variants diverged, maxDiff=${maxDiff}`);

console.log(`grid ${cols}x${rows} (${N} cells), 300 frames`);
console.log(`A clamped IX : ${A.ms.toFixed(3)} ms/step`);
console.log(`B flat index : ${B.ms.toFixed(3)} ms/step`);
console.log(`speedup      : ${(A.ms / B.ms).toFixed(2)}x   maxDiff=${maxDiff}`);
