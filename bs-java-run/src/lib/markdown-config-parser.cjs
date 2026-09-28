function stripMarkdownValue(value) {
  return String(value || '').trim().replace(/^`|`$/g, '').replace(/\\([\\|])/g, '$1');
}

function splitMarkdownTableRow(line) {
  const cells = [];
  let start = 0;
  for (let index = 0; index < line.length; index++) {
    if (line[index] !== '|') continue;
    let precedingSlashes = 0;
    for (let cursor = index - 1; cursor >= 0 && line[cursor] === '\\'; cursor--) precedingSlashes++;
    if (precedingSlashes % 2 === 1) continue;
    cells.push(line.slice(start, index));
    start = index + 1;
  }
  cells.push(line.slice(start));
  if (cells.length < 3 || cells[0].trim() !== '' || cells.at(-1).trim() !== '') return null;
  return cells.slice(1, -1).map(stripMarkdownValue);
}

function isMarkdownTableSeparator(cells) {
  return cells.length > 0 && cells.every(cell => /^:?-{1,}:?$/.test(cell.trim()));
}

function readFenceMarker(line) {
  const match = line.trim().match(/^(`{3,}|~{3,})/);
  return match ? { character: match[1][0], length: match[1].length } : null;
}

/** 按 Markdown 二级标题和表头首列读取 GFM 表格，并保留转义竖线所在的单元格。 */
function parseMultiColumnTable(content, sectionHeading, headerFirstCell, options = {}) {
  const rows = [];
  const lines = String(content || '').split(/\r?\n/);
  let inSection = false;
  let inTable = false;
  let columnCount = 0;
  let fence = null;

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim();
    const marker = readFenceMarker(trimmed);
    if (fence) {
      if (marker?.character === fence.character && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      if (!inSection && trimmed.toLowerCase().includes(sectionHeading.toLowerCase())) {
        inSection = true;
        inTable = false;
        continue;
      }
      if (inSection) break;
    }
    if (!inSection) continue;

    if (!trimmed.startsWith('|')) {
      inTable = false;
      continue;
    }
    const cells = splitMarkdownTableRow(trimmed);
    if (!cells) continue;
    if (!inTable) {
      if (cells[0] === headerFirstCell) {
        inTable = true;
        columnCount = cells.length;
      }
      continue;
    }
    if (isMarkdownTableSeparator(cells)) continue;
    if (cells.length !== columnCount && !(options.allowExtraColumns && cells.length > columnCount)) {
      throw new Error(`Markdown 配置表“${sectionHeading}”第 ${index + 1} 行列数错误：表头 ${columnCount} 列，实际 ${cells.length} 列`);
    }
    rows.push(cells);
  }
  return rows;
}

/** 读取指定二级标题正文，给 JDK 路径等非表格配置使用。 */
function readMarkdownSection(content, sectionHeading) {
  const lines = String(content || '').split(/\r?\n/);
  const heading = sectionHeading.trim().toLowerCase();
  let inSection = false;
  let fence = null;
  const body = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const marker = readFenceMarker(trimmed);
    if (fence) {
      if (inSection) body.push(line);
      if (marker?.character === fence.character && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      if (inSection) body.push(line);
      fence = marker;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      if (!inSection && trimmed.slice(3).trim().toLowerCase() === heading) {
        inSection = true;
        continue;
      }
      if (inSection) break;
    }
    if (inSection) body.push(line);
  }
  return inSection ? body.join('\n') : null;
}

module.exports = { parseMultiColumnTable, readMarkdownSection };
