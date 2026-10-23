#!/usr/bin/env node
import { scsay } from './say.mjs';

process.exitCode = await scsay({
  argv: process.argv.slice(2),
  env: process.env,
  platform: process.platform,
  fds: [0, 1, 2],
});
