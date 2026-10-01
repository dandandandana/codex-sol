import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';

const schema = JSON.parse(readFileSync(fileURLToPath(new URL('../runtime.schema.json', import.meta.url)), 'utf8'));
const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
const validators = new Map();

export function assertContract(name, value) {
  let validator = validators.get(name);
  if (!validator) {
    if (!Object.hasOwn(schema.$defs, name)) throw new Error(`Unknown contract: ${name}`);
    validator = ajv.compile({ ...schema, $ref: `#/$defs/${name}` });
    validators.set(name, validator);
  }
  if (!validator(value)) {
    const details = ajv.errorsText(validator.errors, { separator: '; ' });
    throw new TypeError(`${name} contract invalid: ${details}`);
  }
  return value;
}

export const RUNTIME_SCHEMA = schema;
