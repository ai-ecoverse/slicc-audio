#!/usr/bin/env node
import { scplay } from './play.mjs';

process.exitCode = await scplay({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  fds: [0, 1, 2],
});
