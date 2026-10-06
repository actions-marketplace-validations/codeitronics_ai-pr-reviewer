// dist/action.js: the GitHub Action, fully self-contained (Actions don't install node_modules). Committed.
// dist/cli.js:    the npm CLI + web UI; its dependencies are installed by npm, so they stay external.
import { build } from "esbuild";

const common = { bundle: true, platform: "node", format: "esm", target: "node20", sourcemap: false, legalComments: "none", logLevel: "info" };

await build({ ...common, entryPoints: ["src/github/action.ts"], outfile: "dist/action.js", target: "node24", minify: true });
await build({ ...common, entryPoints: ["src/cli.ts"], outfile: "dist/cli.js", packages: "external" });
