import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';
import { schemas } from '../lib/validation.js';

test('application contract references real shared schemas and every schema compiles', () => {
  const contract = JSON.parse(readFileSync(new URL('../../application.openapi.json', import.meta.url), 'utf8'));
  assert.equal(contract.openapi, '3.1.0');
  const ajv = new Ajv({ strict: false, validateFormats: false });
  ajv.addSchema(schemas);
  for (const name of Object.keys(schemas.definitions)) ajv.compile({ $ref: `${schemas.$id}#/definitions/${name}` });
  let references = 0;
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    if (value.$ref) {
      references++;
      if (value.$ref.startsWith('#/')) {
        let target = contract;
        for (const key of value.$ref.slice(2).split('/')) target = target?.[key];
        assert.ok(target, value.$ref);
      } else {
        assert.match(value.$ref, /^\.\/server\/schemas\.json#\/definitions\/\w+$/);
        assert.ok(schemas.definitions[value.$ref.split('/').at(-1)], value.$ref);
      }
    }
    for (const child of Object.values(value)) visit(child);
  }
  visit(contract);
  assert.ok(references >= 15);
});
