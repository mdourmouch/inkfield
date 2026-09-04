// The solver is verified numerically by bench/step.mjs. This covers the other half:
// that the renderer wiring, the input path and teardown actually hold together, on a DOM
// stub thin enough to run under node. It checks that ink reaches the screen and that
// destroy() leaves nothing running -- not what the pixels look like.
import assert from 'node:assert';

const listeners = new Map();
const stub2d = () => ({
  fillStyle: '#000000', font: '', textAlign: '', textBaseline: '',
  setTransform() {}, fillText() {}, fillRect() {}, clearRect() {}, drawImage() {},
});
const makeCanvas = (webgl = null) => ({
  width: 0, height: 0, style: { cssText: '' },
  getContext: (kind) => (kind === '2d' ? stub2d() : webgl),
  getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  addEventListener() {}, removeEventListener() {}, remove() {},
});

// A WebGL2 context thin enough to record what was called on it. Constants come back as
// their own name, which is distinct enough for the code under test.
function makeGL(calls) {
  const ext = { loseContext: () => calls.push('loseContext') };
  return new Proxy({}, {
    get(_, k) {
      if (typeof k !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(k)) return k;
      if (k === 'getShaderParameter' || k === 'getProgramParameter') return () => true;
      if (k === 'getExtension') return () => ext;
      return (...a) => { calls.push(k); return {}; };
    },
  });
}

let rafId = 0;
const pending = new Map();
globalThis.document = { createElement: () => makeCanvas(), body: { appendChild() {} } };
globalThis.window = {
  devicePixelRatio: 2,
  addEventListener: (t, fn) => listeners.set(t, fn),
  removeEventListener: (t) => listeners.delete(t),
};
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (fn) => { pending.set(++rafId, fn); return rafId; };
globalThis.cancelAnimationFrame = (id) => pending.delete(id);
const tick = () => { const [[id, fn]] = pending; pending.delete(id); fn(performance.now()); };

const { createInkfield } = await import('./src/inkfield.js');
const ink = createInkfield({ background: '#07080b' });

assert.equal(ink.renderer, 'canvas2d', 'should fall back when WebGL2 is unavailable');
assert.equal(ink.stats.cols, Math.floor(800 / ink.params.cellSize), 'grid follows the CSS box');
assert.equal(ink.stats.dpr, 2, 'backing store follows devicePixelRatio');

// A pointer move anywhere on the page must land as ink, since the canvas is a background
// with pointer-events:none and never receives the event itself.
// One move is deliberately below the first ramp step -- a single dab of ink maps to the
// blank glyph. The trail appears once density accumulates over a few frames.
const move = listeners.get('pointermove');
move({ clientX: 400, clientY: 300 });
tick();
assert.equal(ink.stats.drawnCells, 0, 'a single faint dab maps to the blank glyph');
for (let i = 0; i < 4; i++) { move({ clientX: 400, clientY: 300 }); tick(); }
assert.ok(ink.stats.drawnCells > 0, `an accumulating trail should draw, got ${ink.stats.drawnCells}`);

// Ink outside the canvas would smear against the boundary clamp, so it is dropped.
const before = ink.stats.drawnCells;
ink.inject(-50, -50, { density: 5 });
tick();
assert.ok(ink.stats.drawnCells <= before, 'out-of-bounds injection should be ignored');

// Density fades, so an untouched field empties instead of holding the last frame forever.
for (let i = 0; i < 800; i++) tick();
assert.equal(ink.stats.drawnCells, 0, 'field should dissipate to nothing when left alone');

ink.burst(400, 300);
tick();
assert.ok(ink.stats.drawnCells > 0, 'burst should draw glyphs');

// Two live loops is two simulations: React strict mode mounts twice.
ink.destroy();
assert.equal(pending.size, 0, 'destroy() should cancel the animation frame');
assert.equal(listeners.size, 0, 'destroy() should remove its window listeners');
assert.equal(ink.running, false);
ink.destroy();   // idempotent

// A canvas gets one WebGL context for its lifetime. React strict mode unmounts and
// remounts against the same element, so destroy() must leave that context usable --
// otherwise the second mount inherits a lost context and compileShader fails with a null
// info log, which surfaces in Next as a bare `Error: null` out of the layout.
const calls = [];
const shared = makeCanvas(makeGL(calls));
const first = createInkfield({ canvas: shared, background: '#07080b' });
assert.equal(first.renderer, 'webgl2');
first.destroy();
assert.ok(!calls.includes('loseContext'), 'must not lose the context of a canvas it does not own');
assert.ok(calls.includes('deleteProgram') && calls.includes('deleteTexture'), 'GL resources should be released');
const second = createInkfield({ canvas: shared, background: '#07080b' });
assert.equal(second.renderer, 'webgl2', 'a remount on the same canvas must still get WebGL2');
second.destroy();

// An owned canvas is removed from the document, so its context can go with it.
const ownedCalls = [];
globalThis.document.createElement = () => makeCanvas(makeGL(ownedCalls));
createInkfield({ background: '#07080b' }).destroy();
assert.ok(ownedCalls.includes('loseContext'), 'an owned canvas should release its context');

console.log('ok — renderer wiring, input, dissipation, teardown and remount');
