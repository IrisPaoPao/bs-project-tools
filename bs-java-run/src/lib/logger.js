import { getConfig } from './config.js';
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

export const GREEN = '[32m';
export const YELLOW = '[33m';
export const RED = '[31m';
export const CYAN = '[36m';
export const RESET = '[0m';

export function info(msg) {
  console.log(`${YELLOW}[INFO]${RESET}  ${msg}`);
}

export function success(msg) {
  console.log(`${GREEN}[OK]${RESET}    ${msg}`);
}

export function error(msg) {
  console.log(`${RED}[FAIL]${RESET}  ${msg}`);
}

export function warn(msg) {
  console.log(`${YELLOW}[WARN]${RESET}  ${msg}`);
}

export function log(msg) {
  console.log(msg);
}

export function header(title) {
  console.log('');
  console.log('==========================================================');
  console.log(`  ${title}`);
  console.log('==========================================================');
}

export function footer() {
  console.log('==========================================================');
  console.log('');
}

export function table(headers, rows) {
  // 计算每列最大宽度
  const colWidths = headers.map((h, i) => {
    const maxData = rows.reduce((max, row) => Math.max(max, String(row[i] || '').length), 0);
    return Math.max(String(h).length, maxData);
  });

  // 打印表头
  const headerLine = headers.map((h, i) => String(h).padEnd(colWidths[i])).join('  ');
  console.log(headerLine);
  console.log(colWidths.map(w => '-'.repeat(w)).join('  '));

  // 打印数据行
  for (const row of rows) {
    const line = row.map((cell, i) => String(cell || '').padEnd(colWidths[i])).join('  ');
    console.log(line);
  }
}

// 交互式选择
export async function interactiveSelect(items, prompt = '请选择') {
  if (typeof process === 'undefined' || !process.stdin.isTTY) {
    throw new Error('非交互式终端，无法选择');
  }

  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}) ${items[i]}`);
  }
  console.log('  a) 全部');
  console.log('  q) 退出');
  console.log('');

  return new Promise((resolve) => {
    process.stdout.write(`${prompt}: `);
    process.stdin.once('data', (data) => {
      const choice = data.toString().trim();
      if (choice === 'q' || choice === 'Q') {
        console.log('已取消');
        process.exit(0);
      }
      if (choice === 'a' || choice === 'A') {
        resolve('all');
        return;
      }
      const idx = parseInt(choice, 10);
      if (idx >= 1 && idx <= items.length) {
        resolve(items[idx - 1]);
      } else {
        console.log('无效选择');
        resolve(interactiveSelect(items, prompt));
      }
    });
  });
}

// 交互式选择（单项，无“全部”选项）。items: [{ label, value }]
export async function selectOne(items, prompt = '请选择') {
  if (typeof process === 'undefined' || !process.stdin.isTTY) {
    throw new Error('非交互式终端，无法选择');
  }

  for (let i = 0; i < items.length; i++) {
    console.log(`  ${i + 1}) ${items[i].label}`);
  }
  console.log('  q) 退出');
  console.log('');

  return new Promise((resolve) => {
    process.stdout.write(`${prompt}: `);
    process.stdin.once('data', (data) => {
      const choice = data.toString().trim();
      if (choice === 'q' || choice === 'Q') {
        console.log('已取消');
        process.exit(0);
      }
      const idx = parseInt(choice, 10);
      if (idx >= 1 && idx <= items.length) {
        resolve(items[idx - 1].value);
      } else {
        console.log('无效选择');
        resolve(selectOne(items, prompt));
      }
    });
  });
}

export function jsonOutput(data) {
  console.log(JSON.stringify(data, null, 2));
}

export function quietOutput(msg) {
  console.log(msg);
}
