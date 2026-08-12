import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

/* ## The site reaches one file outside its own directory
 *
 * The labyrinth mark is drawn on five surfaces: the vault's icon, the wallet's
 * icon, both apps' navigation bars, and this site. It became four different
 * drawings, one of which was not even the same figure, because each surface
 * had its own copy of it. So there is one module now, `wallet/src/design/
 * geometry.ts`, and everything draws from it, including
 * `scripts/make-icons.mjs`, which rasterizes the app icons from that same
 * function.
 *
 * The alias is a named path rather than `../../wallet/...` at the import site,
 * so the reason it points outside this directory is written down here instead
 * of looking like an accident. `fs.allow` is what lets the dev server read it;
 * the production build inlines the module and does not consult that list.
 */
const geometryDir = fileURLToPath(new URL("../wallet/src/design", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@labyrinth/geometry": `${geometryDir}/geometry.ts` },
  },
  server: {
    fs: { allow: [".", geometryDir] },
  },
  build: {
    target: "es2022",
  },
});
