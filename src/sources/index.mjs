import { fetchDiscourse } from './discourse.mjs';
import { fetchNht } from './nht.mjs';
import { fetchGeneric } from './generic.mjs';
import { fetchNodeseek } from './nodeseek.mjs';

const ADAPTERS = {
  discourse: fetchDiscourse,
  nht: fetchNht,
  generic: fetchGeneric,
  nodeseek: fetchNodeseek,
};

export function getAdapter(kind) {
  const fn = ADAPTERS[kind];
  if (!fn) throw new Error(`unknown adapter kind: ${kind}`);
  return fn;
}
