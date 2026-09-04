import { Inkfield } from 'inkfield/react';

export default function Page() {
  return (
    <>
      <header className="hero">
        {/* A className opts out of the fixed-background default, so the canvas is laid
            out by the stylesheet: absolute inside the hero, scrolling with the page. */}
        <Inkfield className="hero-ink" background={null} baseHue={210} hueShift={40} />
        <div className="hero-copy">
          <h1>ink<span>field</span></h1>
          <p>
            A Jos Stam stable-fluids simulation rendered as drifting ASCII glyphs.
            Move the pointer across this band to trail ink; <strong>click</strong> for a burst.
          </p>
        </div>
      </header>

      <main>
        <section>
          <h2>Scoped to its own element</h2>
          <p>
            The canvas is <code>position: absolute</code> inside the header, not fixed to the
            viewport. Scroll and it leaves with the rest of the page. A ResizeObserver keeps
            the simulation grid matched to whatever box the canvas ends up in, so the same
            component works as a full-bleed background or a banner like this one.
          </p>
        </section>

        <section>
          <h2>Behind the text, out of the way</h2>
          <p>
            The canvas is <code>pointer-events: none</code>, so the copy above it stays
            selectable and any links keep working. Ink is only injected while the pointer is
            inside the canvas box — move down here and the field stops taking input.
          </p>
          <pre>{`import { Inkfield } from 'inkfield/react';

<header className="hero">
  <Inkfield className="hero-ink" background={null} />
  <h1>…</h1>
</header>`}</pre>
        </section>

        <section>
          <h2>Transparent</h2>
          <p>
            <code>background={'{null}'}</code> draws glyphs onto a transparent canvas
            instead of an opaque ground, which is what lets the band fade into the page
            with a CSS mask rather than ending on a hard edge.
          </p>
          <ul>
            <li>WebGL2 instanced renderer, Canvas2D fallback</li>
            <li>No dependencies, no build step, 13 kB packed</li>
            <li>Respects prefers-reduced-motion</li>
            <li>Static export safe — this page is one</li>
          </ul>
        </section>

        <footer>Disposable demo. Nothing here is meant to survive.</footer>
      </main>
    </>
  );
}
