# Demo pack

A fictional world used for development and tests. It is generated entirely by
code in `packages/pipeline` and holds no game assets or third-party data.

The generated files are not committed. `pnpm dev` and `pnpm build` create them
on first run (about half a minute), and rebuild them when the generator
changes. To rebuild by hand:

```sh
pnpm demo:build            # PMTiles archive (default)
pnpm demo:build --tiles xyz  # plain {z}/{x}/{y} tile folder instead
```

`ATLAS_DEMO_TILES=xyz` makes folder tiles the default for `pnpm dev`, `pnpm build` and `demo:ensure` too. The Android build sets it, because the Android WebView cannot read PMTiles archives from the app.
