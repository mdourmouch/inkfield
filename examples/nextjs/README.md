# inkfield in Next.js

A static-export landing page with the effect scoped to a hero band that scrolls with the
content, rather than pinned behind the whole viewport.

```sh
npm install && npm run dev
```

Three things this shows that the standalone playground cannot:

- **`'use client'` is already in the package**, so `<Inkfield />` drops into a server
  component with no wrapper of your own.
- **`output: 'export'` works.** `next build` prerenders this to static HTML; nothing in
  the library touches `document` outside `useEffect`.
- **A `className` opts out of the fixed-background default**, which is what lets
  `app/globals.css` place the canvas absolutely inside the header and fade its bottom
  edge with a CSS mask.

To try an unpublished change, pack the library and install the tarball:

```sh
cd ../.. && npm pack && cd examples/nextjs && npm i ../../inkfield-*.tgz
```

Use the tarball rather than `npm link` or `file:../..`. Both symlink, Next resolves
through the symlink to the real path, and `inkfield/react` ends up importing a second copy
of React — which fails as `Invalid hook call`.
