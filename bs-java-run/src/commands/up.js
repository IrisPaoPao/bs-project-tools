import { start } from './start.js';

export async function up(serviceArg, options) {
  return start(serviceArg, { ...options, build: true });
}
