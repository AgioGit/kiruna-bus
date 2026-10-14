import Ajv from 'ajv';
import { readFileSync } from 'node:fs';
import { AppError } from './errors.js';

export const schemas = JSON.parse(readFileSync(new URL('../schemas.json', import.meta.url), 'utf8'));
const ajv = new Ajv({ strict: false, allErrors: true });
ajv.addFormat('date-time', {
  type: 'string',
  validate: (value) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)
    && Number.isFinite(Date.parse(value)),
});
ajv.addSchema(schemas);
const validators = new Map();

export function validate(name, value, { upstream = false } = {}) {
  let check = validators.get(name);
  if (!check) {
    check = ajv.compile({ $ref: `${schemas.$id}#/definitions/${name}` });
    validators.set(name, check);
  }
  if (!check(value)) {
    throw new AppError(upstream ? 'UPSTREAM_SCHEMA' : 'INVALID_DATA',
      upstream ? 'The transit provider returned invalid data.' : `Invalid ${name} data.`,
      { status: upstream ? 502 : 500, cause: new Error(ajv.errorsText(check.errors)) });
  }
  return value;
}
