import { createSolver } from './solver.js';

// Sim knobs. Live: mutate `ink.params` and the next frame picks it up. `cellSize` and
// `fontFamily` are the exceptions -- they change the grid and the atlas, so call
// `ink.resize()` after those.
export const defaults = {
  cellSize: 14,
  iterations: 2,
  dt: 0.15,
  viscosity: 0,
  diffusion: 0,
  dissipation: 0.997,      // density fade
  velocityDamping: 0.96,   // velocity fade (localisation)
  mouseRadius: 10,
  mouseDensity: 0.25,
  mouseForce: 0.005,       // negative for a backward impulse
  clickRadius: 66,
  clickForce: 1.6,
  clickDensity: 3.1,
  baseHue: 210,
  hueShift: 40,
  saturation: 88,
  lightness: 92,   // glyphs are thin marks on a dark ground; below ~90 the faint ones vanish
  alpha: 1,
};

// Glyphs are quantised into hue buckets for the Canvas2D atlas. WebGL2 colours per
// instance in the shader, so it uses one white row and no bucketing.
const HUE_STEPS = 16;
// Tiles are padded past the cell so a tall glyph overflows into its own tile instead of
// bleeding into the neighbour and blitting as a stray fragment.
const TILE_PAD = 1.4;

const VERT = `#version 300 es
in vec2 a_corner;
in vec4 a_inst;                        // i, j, glyphIdx, val
uniform vec2 u_res, u_uvTile;
uniform float u_cell, u_tile, u_off;
out vec2 v_uv;
out float v_val;
void main() {
  vec2 px = vec2(a_inst.x, a_inst.y) * u_cell - u_off + a_corner * u_tile;
  vec2 clip = px / u_res * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);
  v_uv = (vec2(a_inst.z, 0.0) + a_corner) * u_uvTile;
  v_val = a_inst.w;
}`;

const FRAG = `#version 300 es
precision mediump float;
in vec2 v_uv;
in float v_val;
uniform sampler2D u_atlas;
uniform float u_baseHue, u_hueShift, u_sat, u_light, u_alpha;
out vec4 outColor;
vec3 hsl2rgb(float h, float s, float l) {
  h = mod(h, 360.0) / 60.0;
  float c = (1.0 - abs(2.0 * l - 1.0)) * s;
  float x = c * (1.0 - abs(mod(h, 2.0) - 1.0));
  vec3 r = h < 1.0 ? vec3(c, x, 0.0) : h < 2.0 ? vec3(x, c, 0.0)
         : h < 3.0 ? vec3(0.0, c, x) : h < 4.0 ? vec3(0.0, x, c)
         : h < 5.0 ? vec3(x, 0.0, c) : vec3(c, 0.0, x);
  return r + (l - c * 0.5);
}
void main() {
  // Atlas glyphs are white, so .a carries coverage regardless of premultiplication.
  float a = texture(u_atlas, v_uv).a;
  if (a < 0.01) discard;
  // Premultiplied, so a transparent canvas composites without bright fringes.
  float o = a * u_alpha;
  outColor = vec4(hsl2rgb(u_baseHue + v_val * u_hueShift, u_sat, u_light) * o, o);
}`;

/**
 * Start the effect. Returns a handle; call `destroy()` when the element goes away --
 * React strict mode mounts twice, and two live rAF loops is two simulations.
 */
export function createInkfield(options = {}) {
  const params = {};
  for (const k in defaults) params[k] = options[k] ?? defaults[k];

  const glyphs = options.glyphs ?? ' _<o';
  const fontFamily = options.fontFamily ?? 'monospace';
  const background = options.background === undefined ? '#07080b' : options.background;
  const maxDpr = options.maxDpr ?? 2;
  const respectReducedMotion = options.reducedMotion !== 'ignore';
  const onFrame = options.onFrame;

  // A created canvas is ours to style and to remove; a supplied one is the caller's.
  const owned = !options.canvas;
  const canvas = options.canvas ?? document.createElement('canvas');
  if (owned) {
    canvas.style.cssText =
      `position:fixed;inset:0;width:100%;height:100%;display:block;pointer-events:none;` +
      `z-index:${options.zIndex ?? -1}`;
    (options.container ?? document.body).appendChild(canvas);
  }

  // A canvas gets one context for its lifetime, so the backend is chosen once, here.
  const transparent = background === null;
  const want = options.renderer ?? 'auto';
  let gl = want === 'canvas2d' ? null
         : canvas.getContext('webgl2', { alpha: transparent, antialias: false, desynchronized: true });
  const ctx = gl ? null : canvas.getContext('2d', { alpha: transparent, desynchronized: true });
  const renderer = gl ? 'webgl2' : 'canvas2d';

  const atlas = document.createElement('canvas');
  const atlasCtx = atlas.getContext('2d');

  // Assigning to fillStyle normalises any CSS colour to #rrggbb, so the browser does the
  // parsing and `background` accepts 'rebeccapurple' as happily as '#07080b'.
  function parseColor(css) {
    atlasCtx.fillStyle = '#000';
    atlasCtx.fillStyle = css;
    const n = parseInt(atlasCtx.fillStyle.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }
  const bg = transparent ? [0, 0, 0] : parseColor(background);

  let solver = null, inst = null;
  let cols = 0, rows = 0, dpr = 1, cssW = 0, cssH = 0;
  let tileCss = 0, tilePx = 0, tileOff = 0;
  let prog, vao, instBuf, cornerBuf, tex;
  const uni = {};

  const stats = {
    renderer, dpr: 1, cols: 0, rows: 0, cells: 0,
    fps: 0, frameMs: 0, stepMs: 0, renderMs: 0, frameIntervalMs: 0,
    activeCells: 0, drawnCells: 0,
  };

  function compile(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    // A silent shader failure renders a blank screen with no error, so fail loudly -- and
    // with the driver's log, which is empty often enough that "Error: null" is a real risk.
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
      const log = gl.getShaderInfoLog(s) || '(driver returned no log)';
      throw new Error(`inkfield: ${kind} shader failed to compile\n${log}`);
    }
    return s;
  }

  function initGL() {
    prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      throw new Error('inkfield: shader program failed to link\n' + (gl.getProgramInfoLog(prog) || '(driver returned no log)'));
    }
    gl.useProgram(prog);
    for (const n of ['u_res', 'u_uvTile', 'u_cell', 'u_tile', 'u_off',
                     'u_baseHue', 'u_hueShift', 'u_sat', 'u_light', 'u_alpha']) {
      uni[n] = gl.getUniformLocation(prog, n);
    }

    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    cornerBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const cLoc = gl.getAttribLocation(prog, 'a_corner');
    gl.enableVertexAttribArray(cLoc);
    gl.vertexAttribPointer(cLoc, 2, gl.FLOAT, false, 0, 0);

    instBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    const iLoc = gl.getAttribLocation(prog, 'a_inst');
    gl.enableVertexAttribArray(iLoc);
    gl.vertexAttribPointer(iLoc, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(iLoc, 1);     // one a_inst per cell, not per vertex

    tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR],
                            [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) {
      gl.texParameteri(gl.TEXTURE_2D, k, val);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);   // shader emits premultiplied
    gl.clearColor(bg[0], bg[1], bg[2], transparent ? 0 : 1);
  }

  function buildAtlas() {
    tileCss = params.cellSize * TILE_PAD;
    tilePx = tileCss * dpr;
    tileOff = (tileCss - params.cellSize) * 0.5;
    // Assigning width/height clears the canvas and resets state, so transform comes after.
    const hueRows = gl ? 1 : HUE_STEPS;  // GL colours in the shader; 2D needs them baked
    atlas.width = Math.ceil(glyphs.length * tilePx);
    atlas.height = Math.ceil(hueRows * tilePx);
    atlasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    atlasCtx.font = `${Math.floor(params.cellSize * 0.85)}px ${fontFamily}`;
    atlasCtx.textAlign = 'center';
    atlasCtx.textBaseline = 'middle';
    const half = tileCss * 0.5;
    for (let k = 0; k < hueRows; k++) {
      atlasCtx.fillStyle = gl ? '#fff'
        : `hsla(${params.baseHue + (k / (HUE_STEPS - 1)) * params.hueShift}, ${params.saturation}%, ${params.lightness}%, ${params.alpha})`;
      for (let c = 0; c < glyphs.length; c++) {
        atlasCtx.fillText(glyphs[c], c * tileCss + half, k * tileCss + half);
      }
    }

    if (gl) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      gl.uniform2f(uni.u_uvTile, tilePx / atlas.width, tilePx / atlas.height);
    }
  }

  // Render at the display's real pixel density: a backing store smaller than the CSS box
  // gets stretched by the compositor, and that upscale is what makes glyphs look blurry
  // next to a paragraph. Capped, because past 2x the fragment cost squares for nothing.
  function resize() {
    if (!cssW || !cssH) return;
    dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    if (gl) gl.viewport(0, 0, canvas.width, canvas.height);
    else ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cols = Math.max(2, Math.floor(cssW / params.cellSize));
    rows = Math.max(2, Math.floor(cssH / params.cellSize));
    const prev = solver;
    solver = createSolver(cols, rows, params);
    // Carry the ink across a resize where the grid shape allows, so a window drag or a
    // phone rotation does not blank the field.
    if (prev && prev.cols === cols && prev.rows === rows) {
      solver.density.set(prev.density); solver.u.set(prev.u); solver.v.set(prev.v);
    }
    inst = new Float32Array(cols * rows * 4);

    if (gl) {
      gl.uniform2f(uni.u_res, cssW, cssH);
      gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
      gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
    }
    stats.dpr = dpr; stats.cols = cols; stats.rows = rows; stats.cells = cols * rows;
    buildAtlas();
    if (!running) paint();   // keep a stopped canvas correct across a resize
  }

  // The sim -> visual mapping lives here once; the backends differ only in how they
  // consume the resulting instance list.
  function render() {
    const { density, u, v } = solver;
    const last = glyphs.length - 1;
    let activeCells = 0, n = 0;

    for (let j = 0; j < rows; j++) {
      for (let i = 0, idx = j * cols; i < cols; i++, idx++) {
        const d = density[idx];
        if (d <= 0.005) continue;

        activeCells += 1;
        const ux = u[idx], vy = v[idx];
        const val = Math.min(1, d + Math.sqrt(ux * ux + vy * vy) * 0.1);

        // glyphs[0] is ' ': below one ramp step the glyph is blank, so drawing it would
        // cost a call and paint nothing. `d > 0.005` asks "is there density here"; the
        // question that matters is "does this produce a visible glyph".
        const charIdx = (val * last) | 0;
        if (charIdx === 0) continue;

        inst[n] = i; inst[n + 1] = j; inst[n + 2] = charIdx; inst[n + 3] = val;
        n += 4;
      }
    }

    stats.activeCells = activeCells;
    stats.drawnCells = n >> 2;
    if (gl) drawGL(n >> 2); else draw2D(n);
  }

  // One instanced call for the whole grid, so cost is flat in the number of cells.
  function drawGL(count) {
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, instBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst, 0, count * 4);
    gl.uniform1f(uni.u_cell, params.cellSize);
    gl.uniform1f(uni.u_tile, tileCss);
    gl.uniform1f(uni.u_off, tileOff);
    gl.uniform1f(uni.u_baseHue, params.baseHue);
    gl.uniform1f(uni.u_hueShift, params.hueShift);
    gl.uniform1f(uni.u_sat, params.saturation / 100);
    gl.uniform1f(uni.u_light, params.lightness / 100);
    gl.uniform1f(uni.u_alpha, params.alpha);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
  }

  // The fallback when WebGL2 is missing: one drawImage per glyph, hue quantised into rows.
  function draw2D(n) {
    if (transparent) ctx.clearRect(0, 0, cssW, cssH);
    else { ctx.fillStyle = background; ctx.fillRect(0, 0, cssW, cssH); }
    const cell = params.cellSize, lastHue = HUE_STEPS - 1, src = tilePx;
    for (let k = 0; k < n; k += 4) {
      ctx.drawImage(
        atlas,
        inst[k + 2] * src, ((inst[k + 3] * lastHue) | 0) * src, src, src,
        inst[k] * cell - tileOff, inst[k + 1] * cell - tileOff, tileCss, tileCss
      );
    }
  }

  function paint() {
    if (gl) { gl.clear(gl.COLOR_BUFFER_BIT); }
    else if (transparent) ctx.clearRect(0, 0, cssW, cssH);
    else { ctx.fillStyle = background; ctx.fillRect(0, 0, cssW, cssH); }
  }

  // --- input -------------------------------------------------------------------------
  // Listeners sit on window, not the canvas: as a background the canvas is
  // pointer-events:none, so the events never reach it. Coordinates are converted against
  // a rect read once per frame inside the loop, which also covers scrolling and layout
  // shifts without a scroll listener.
  let pendingMove = null, pendingBurst = null;
  let lastX = 0, lastY = 0, moved = false;

  const onPointerMove = (e) => {
    const dx = moved ? e.clientX - lastX : 0;
    const dy = moved ? e.clientY - lastY : 0;
    pendingMove = { x: e.clientX, y: e.clientY, dx, dy };
    lastX = e.clientX; lastY = e.clientY; moved = true;
  };
  const onPointerDown = (e) => { pendingBurst = { x: e.clientX, y: e.clientY }; };

  function applyInput() {
    if (!pendingMove && !pendingBurst) return;
    const r = canvas.getBoundingClientRect();
    if (pendingMove) {
      const { x, y, dx, dy } = pendingMove;
      inject(x - r.left, y - r.top, {
        radius: params.mouseRadius, density: params.mouseDensity,
        fx: dx * params.mouseForce, fy: dy * params.mouseForce,
      });
      pendingMove = null;
    }
    if (pendingBurst) {
      burst(pendingBurst.x - r.left, pendingBurst.y - r.top);
      pendingBurst = null;
    }
  }

  const inBounds = (x, y) => x >= 0 && y >= 0 && x < cssW && y < cssH;

  /** Push ink at a point, in CSS pixels relative to the canvas. */
  function inject(x, y, o = {}) {
    if (!solver || !inBounds(x, y)) return;
    const cell = params.cellSize;
    solver.inject(
      Math.floor(x / cell), Math.floor(y / cell),
      Math.ceil((o.radius ?? params.mouseRadius) / cell),
      o.density ?? params.mouseDensity, o.fx ?? 0, o.fy ?? 0,
    );
  }

  /** Radial burst at a point, in CSS pixels relative to the canvas. */
  function burst(x, y, o = {}) {
    if (!solver || !inBounds(x, y)) return;
    const cell = params.cellSize;
    solver.burst(
      Math.floor(x / cell), Math.floor(y / cell),
      Math.ceil((o.radius ?? params.clickRadius) / cell),
      o.density ?? params.clickDensity, o.force ?? params.clickForce,
    );
  }

  // --- loop --------------------------------------------------------------------------
  let raf = 0, running = false, lastRaf = 0, fpsFrames = 0, lastFpsAt = 0;

  function frame(now) {
    raf = requestAnimationFrame(frame);
    if (!solver) return;                 // mounted at zero size; wait for a real box
    const frameStart = performance.now();
    applyInput();

    const stepStart = performance.now();
    solver.step();
    const stepEnd = performance.now();
    render();
    const renderEnd = performance.now();

    stats.stepMs = stepEnd - stepStart;
    stats.renderMs = renderEnd - stepEnd;
    stats.frameMs = renderEnd - frameStart;
    // Wall-clock interval (vsync and compositing included), as distinct from JS work.
    stats.frameIntervalMs = lastRaf ? now - lastRaf : 0;
    lastRaf = now;

    fpsFrames += 1;
    const elapsed = renderEnd - lastFpsAt;
    if (elapsed >= 500) {
      stats.fps = (fpsFrames * 1000) / elapsed;
      fpsFrames = 0;
      lastFpsAt = renderEnd;
    }
    if (onFrame) onFrame(stats);
  }

  function start() {
    if (running || destroyed) return;
    running = true;
    lastRaf = 0; fpsFrames = 0; lastFpsAt = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    raf = 0;
  }

  // --- lifecycle ---------------------------------------------------------------------
  let destroyed = false;

  if (gl) initGL();

  // Observing the canvas rather than listening for window resize covers a sized container
  // as well as a full-viewport background. Only the backing store is written, never the
  // CSS size, so this cannot feed back into itself.
  const rect0 = canvas.getBoundingClientRect();
  cssW = rect0.width; cssH = rect0.height;
  resize();

  const ro = new ResizeObserver(([entry]) => {
    const box = entry.contentRect;
    if (box.width === cssW && box.height === cssH) return;
    cssW = box.width; cssH = box.height;
    resize();
  });
  ro.observe(canvas);

  // devicePixelRatio can change with no resize event -- dragging a window between a retina
  // and a non-retina monitor keeps the CSS size identical. Each query is pinned to the
  // current density and fires once it stops matching, so re-arm against the new value.
  (function watchDpr() {
    matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
      .addEventListener('change', () => { if (!destroyed) { resize(); watchDpr(); } }, { once: true });
  })();

  // A backgrounded tab or a GPU reset can drop the context; without this the canvas stays
  // blank for the rest of the page's life.
  const onLost = (e) => { e.preventDefault(); stop(); };
  const onRestored = () => { initGL(); resize(); if (motionAllowed()) start(); };
  if (gl) {
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);
  }

  const motionMq = matchMedia('(prefers-reduced-motion: reduce)');
  const motionAllowed = () => !respectReducedMotion || !motionMq.matches;
  const onMotionChange = () => { if (motionAllowed()) start(); else { stop(); paint(); } };
  motionMq.addEventListener('change', onMotionChange);

  window.addEventListener('pointermove', onPointerMove, { passive: true });
  window.addEventListener('pointerdown', onPointerDown, { passive: true });

  if (motionAllowed()) start();

  return {
    renderer,
    params,
    stats,
    inject,
    burst,
    start,
    stop,
    /** Re-read the canvas size and rebuild the grid. Call after changing `cellSize`. */
    resize,
    get running() { return running; },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      ro.disconnect();
      motionMq.removeEventListener('change', onMotionChange);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerdown', onPointerDown);
      if (gl) {
        canvas.removeEventListener('webglcontextlost', onLost);
        canvas.removeEventListener('webglcontextrestored', onRestored);
        gl.deleteProgram(prog);
        gl.deleteVertexArray(vao);
        gl.deleteBuffer(instBuf);
        gl.deleteBuffer(cornerBuf);
        gl.deleteTexture(tex);
        // A canvas gets one context for its lifetime, so losing it is permanent. A
        // supplied canvas can be mounted again -- React strict mode does exactly that --
        // and the second mount would inherit the dead context, where compileShader fails
        // with no info log. Only force the context away when the canvas goes with it.
        if (owned) gl.getExtension('WEBGL_lose_context')?.loseContext();
      }
      if (owned) canvas.remove();
      solver = null; inst = null;
    },
  };
}
