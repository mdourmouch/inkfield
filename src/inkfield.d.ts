export interface InkfieldParams {
  cellSize: number;
  iterations: number;
  dt: number;
  viscosity: number;
  diffusion: number;
  dissipation: number;
  velocityDamping: number;
  mouseRadius: number;
  mouseDensity: number;
  mouseForce: number;
  clickRadius: number;
  clickForce: number;
  clickDensity: number;
  baseHue: number;
  hueShift: number;
  saturation: number;
  lightness: number;
  alpha: number;
}

export interface InkfieldStats {
  renderer: 'webgl2' | 'canvas2d';
  dpr: number;
  cols: number;
  rows: number;
  cells: number;
  fps: number;
  /** JS work for this frame: step + render. */
  frameMs: number;
  stepMs: number;
  renderMs: number;
  /** Wall-clock gap since the previous frame, vsync and compositing included. */
  frameIntervalMs: number;
  activeCells: number;
  drawnCells: number;
}

export interface InkfieldOptions extends Partial<InkfieldParams> {
  /** Draw into this canvas. Omit and one is created, styled as a fixed background. */
  canvas?: HTMLCanvasElement;
  /** Parent for a created canvas. Default: document.body. */
  container?: Element;
  /** Default 'auto': WebGL2 where available, Canvas2D otherwise. */
  renderer?: 'auto' | 'webgl2' | 'canvas2d';
  /** Any CSS colour, or null for a transparent canvas. Default '#07080b'. */
  background?: string | null;
  /** Density ramp, darkest first. The first glyph is never drawn. Default ' _<o'. */
  glyphs?: string;
  fontFamily?: string;
  /** Pixel-density cap. Default 2. */
  maxDpr?: number;
  /** z-index for a created canvas. Default -1. */
  zIndex?: number;
  /** 'ignore' runs the animation even under prefers-reduced-motion. Default 'respect'. */
  reducedMotion?: 'respect' | 'ignore';
  onFrame?: (stats: InkfieldStats) => void;
}

export interface InkfieldHandle {
  readonly renderer: 'webgl2' | 'canvas2d';
  /** Live: mutate and the next frame uses it. After `cellSize`, call `resize()`. */
  readonly params: InkfieldParams;
  readonly stats: InkfieldStats;
  readonly running: boolean;
  /** Push ink at a point, in CSS pixels relative to the canvas. */
  inject(x: number, y: number, options?: { radius?: number; density?: number; fx?: number; fy?: number }): void;
  /** Radial burst at a point, in CSS pixels relative to the canvas. */
  burst(x: number, y: number, options?: { radius?: number; density?: number; force?: number }): void;
  start(): void;
  stop(): void;
  resize(): void;
  destroy(): void;
}

export declare const defaults: InkfieldParams;
export declare function createInkfield(options?: InkfieldOptions): InkfieldHandle;
