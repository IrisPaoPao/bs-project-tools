import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  topologicalSort,
  reverseTopologicalSort,
  resolveDependenciesClosure,
  findRunningReverseDependents,
} from '../../src/lib/service-selector.js';

const baseService = { name: 'saas-zhsf-base', port: 18080, dependsOn: [] };
const adapterService = { name: 'saas-zhsf-voucher-adapter', port: 18081, dependsOn: ['saas-zhsf-base'] };
const bizService = { name: 'saas-zhsf-business', port: 18082, dependsOn: ['saas-zhsf-base', 'saas-zhsf-voucher-adapter'] };

const allServices = [bizService, adapterService, baseService];

test('topologicalSort sorts services so dependencies come before dependents', () => {
  const sorted = topologicalSort(allServices);
  const names = sorted.map(s => s.name);

  assert.deepEqual(names, ['saas-zhsf-base', 'saas-zhsf-voucher-adapter', 'saas-zhsf-business']);
});

test('reverseTopologicalSort returns reverse topological order for stopping', () => {
  const reverseSorted = reverseTopologicalSort(allServices);
  const names = reverseSorted.map(s => s.name);

  assert.deepEqual(names, ['saas-zhsf-business', 'saas-zhsf-voucher-adapter', 'saas-zhsf-base']);
});

test('resolveDependenciesClosure automatically includes all transitive dependencies', () => {
  const closure = resolveDependenciesClosure([bizService], allServices);
  const names = closure.map(s => s.name);

  assert.deepEqual(names, ['saas-zhsf-base', 'saas-zhsf-voucher-adapter', 'saas-zhsf-business']);
});

test('findRunningReverseDependents detects downstream running services depending on target', () => {
  const isRunningFn = (service) => service.name === 'saas-zhsf-business';

  const reverseDependents = findRunningReverseDependents([baseService], allServices, isRunningFn);
  assert.deepEqual(reverseDependents, ['saas-zhsf-business']);
});
