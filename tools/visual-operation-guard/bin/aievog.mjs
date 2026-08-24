#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createGuardServer, loadPolicy, validatePolicy } from '../src/index.mjs';

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) result._.push(arg);
    else {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i += 1;
      } else result[key] = true;
    }
  }
  return result;
}

function usage() {
  console.log(`AIEfficiency Visual Operation Guard\n\n` +
    `Commands:\n` +
    `  serve --policy <file> [--state-dir <dir>] [--host 127.0.0.1] [--port 18081]\n` +
    `  validate --policy <file> [--operation-map <file>]\n`);
}

const args = parseArgs(process.argv.slice(2));
const command = args._[0];

try {
  if (command === 'serve') {
    if (!args.policy) throw new Error('--policy is required');
    const rawPolicy = await loadPolicy(resolve(args.policy));
    const app = createGuardServer({
      rawPolicy,
      host: args.host || '127.0.0.1',
      port: Number(args.port || 18081),
      stateDir: resolve(args['state-dir'] || '.aievog-state'),
      apiKey: process.env.AIEVOG_API_KEY || ''
    });
    const address = await app.listen();
    console.log(`AIEfficiency Visual Operation Guard listening on ${typeof address === 'string' ? address : `${address.address}:${address.port}`}`);
    const shutdown = async (signal) => {
      console.log(`Received ${signal}; shutting down.`);
      await app.close();
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown('SIGINT'));
    process.on('SIGTERM', () => void shutdown('SIGTERM'));
  } else if (command === 'validate') {
    if (!args.policy) throw new Error('--policy is required');
    const policy = JSON.parse(await readFile(resolve(args.policy), 'utf8'));
    validatePolicy(policy);
    if (args['operation-map']) {
      const operationMap = JSON.parse(await readFile(resolve(args['operation-map']), 'utf8'));
      if (!operationMap.version || !operationMap.projectId || typeof operationMap.operations !== 'object') throw new Error('operation-map is invalid');
    }
    console.log('Validation passed.');
  } else {
    usage();
    process.exit(command ? 1 : 0);
  }
} catch (error) {
  console.error(`ERROR: ${error.message}`);
  process.exit(1);
}
