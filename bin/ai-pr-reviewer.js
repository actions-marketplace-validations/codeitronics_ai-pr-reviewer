#!/usr/bin/env node
import pc from "picocolors";
import { run } from "../dist/cli.js";

run(process.argv).catch((err) => {
  console.error(pc.red("✗ ") + (err?.message ?? err));
  process.exit(1);
});
