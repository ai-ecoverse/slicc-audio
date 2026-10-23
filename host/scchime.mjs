#!/usr/bin/env node
import { scchime } from './play.mjs';

process.exitCode = await scchime({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  fds: [0, 1, 2],
});
