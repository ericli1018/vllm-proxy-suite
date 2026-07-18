#!/usr/bin/env node
import { main } from './apps/gateway/server.js';

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exit(1);
});
