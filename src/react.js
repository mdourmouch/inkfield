'use client';
import { createElement, useEffect, useRef } from 'react';
import { createInkfield } from './inkfield.js';

const FILL = { position: 'fixed', inset: 0, width: '100%', height: '100%', display: 'block', pointerEvents: 'none', zIndex: -1 };

/**
 * <Inkfield /> renders its own canvas and drives it for as long as it is mounted.
 *
 * Options are read once, on mount: changing a prop later does not restart the effect,
 * because restarting would throw the field away. To animate a parameter, keep a ref to
 * the handle and mutate `handle.params` -- the solver reads it live.
 */
export function Inkfield({ style, className, ...options }) {
  const ref = useRef(null);
  const opts = useRef(options);
  useEffect(() => createInkfield({ canvas: ref.current, ...opts.current }).destroy, []);
  return createElement('canvas', { ref, className, style: style ?? FILL, 'aria-hidden': 'true' });
}
