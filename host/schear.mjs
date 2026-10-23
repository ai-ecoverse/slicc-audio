#!/usr/bin/env node
import { schear } from './hear.mjs';

process.exitCode = await schear({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  fds: [0, 1, 2],
});
