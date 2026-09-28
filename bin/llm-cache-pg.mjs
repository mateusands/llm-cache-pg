#!/usr/bin/env node
import { runCli } from "../dist/cli.mjs";

// exitCode, not process.exit(): output piped to another process is written asynchronously.
process.exitCode = await runCli(process.argv.slice(2));
