import { start } from './start.js';

export async function up(serviceArg, options = {}, dependencies = {}) {
  return start(serviceArg, { ...options, commandName: 'up', build: true }, dependencies);
}
