// Parses the .actor JSON files and checks the structural rules from the Apify specs.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '.actor');
const load = (f) => JSON.parse(readFileSync(join(root, f), 'utf8'));
const errors = [];
const check = (cond, msg) => { if (!cond) errors.push(msg); };

const actor = load('actor.json');
check(actor.actorSpecification === 1, 'actor.json: actorSpecification must be 1');
check(/^[a-z0-9-]+$/.test(actor.name), 'actor.json: name must be kebab-case');
check(/^\d+\.\d+$/.test(actor.version), 'actor.json: version must be N.N');
check(actor.input === './input_schema.json', 'actor.json: input path');
check(actor.storages?.dataset === './dataset_schema.json', 'actor.json: dataset path');

const input = load('input_schema.json');
check(input.schemaVersion === 1 && input.type === 'object' && input.title, 'input: top-level fields');
const editors = {
  string: ['textfield', 'textarea', 'javascript', 'python', 'select', 'datepicker', 'fileupload', 'hidden'],
  boolean: ['checkbox', 'hidden'],
  integer: ['number', 'hidden'],
  number: ['number', 'hidden'],
  array: ['json', 'requestListSources', 'pseudoUrls', 'globs', 'keyValue', 'stringList', 'fileupload', 'select', 'schemaBased', 'hidden'],
  object: ['json', 'proxy', 'schemaBased', 'hidden'],
};
for (const [k, p] of Object.entries(input.properties)) {
  check(p.title && p.description, `input.${k}: title and description required`);
  check(editors[p.type]?.includes(p.editor), `input.${k}: editor ${p.editor} not allowed for ${p.type}`);
  if (p.isSecret) check(['textfield', 'textarea', 'hidden', 'json'].includes(p.editor), `input.${k}: isSecret editor`);
  if (p.editor === 'select') check(Array.isArray(p.enum), `input.${k}: select needs enum`);
  if (p.enumTitles) check(p.enumTitles.length === p.enum.length, `input.${k}: enumTitles length`);
}
for (const r of input.required ?? []) check(r in input.properties, `input.required: ${r} unknown`);
check(input.properties.apiKey.isSecret === true, 'input.apiKey must be isSecret');
const pre = input.properties.tasks.prefill?.[0];
check(pre?.sitekey === '6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-' && pre?.url === 'https://www.google.com/recaptcha/api2/demo', 'input.tasks prefill');

const ds = load('dataset_schema.json');
check(ds.actorSpecification === 1, 'dataset: actorSpecification must be 1');
const formats = ['text', 'number', 'date', 'link', 'boolean', 'image', 'array', 'object'];
for (const [id, v] of Object.entries(ds.views)) {
  check(Array.isArray(v.transformation?.fields), `dataset.views.${id}: transformation.fields`);
  check(v.display?.component === 'table', `dataset.views.${id}: display.component`);
  for (const f of v.transformation.fields) {
    check(f in ds.fields.properties, `dataset.views.${id}: field ${f} not in fields`);
    const fmt = v.display.properties?.[f]?.format;
    if (fmt) check(formats.includes(fmt), `dataset.views.${id}.${f}: bad format ${fmt}`);
  }
}
check(Object.keys(ds.views)[0] === 'overview', 'dataset: overview must be first (default) view');

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}
console.log('Schemas OK: actor.json, input_schema.json, dataset_schema.json');
