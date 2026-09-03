import type { CSSProperties } from 'react';
import type { InkfieldOptions } from './inkfield.js';

export type InkfieldProps = Omit<InkfieldOptions, 'canvas' | 'container'> & {
  style?: CSSProperties;
  className?: string;
};

/** Renders its own canvas and drives the effect while mounted. Options are read once. */
export declare function Inkfield(props: InkfieldProps): JSX.Element;
