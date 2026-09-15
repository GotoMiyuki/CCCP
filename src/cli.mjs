import { readFile } from 'node:fs/promises';
import { check } from './contracts.mjs';
import { discover } from './repository.mjs';

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'discover' && args.length === 1) console.log(JSON.stringify(await discover(args[0]), null, 2));
  else if (command === 'validate' && args.length === 2) {
    check(args[0], JSON.parse(await readFile(args[1], 'utf8')));
    console.log(`${args[0]}: valid`);
  } else {
    console.error('Usage: node src/cli.mjs discover <repository> | validate <ContractName> <file.json>'); process.exitCode = 2;
  }
} catch (error) { console.error(`${error.code ?? 'ERROR'}: ${error.message}`); process.exitCode = 1; }
