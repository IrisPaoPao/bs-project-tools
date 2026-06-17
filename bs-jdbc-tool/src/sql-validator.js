export class SqlValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SqlValidationError';
  }
}

/**
 * Ensures SQL contains only a single statement.
 * Strips trailing semicolon, ignores semicolons in strings, identifiers, and comments.
 * @param {string} sql - SQL statement to validate
 * @returns {string} SQL without trailing semicolon
 * @throws {SqlValidationError} if multiple statements detected
 */
export function ensureSingleStatement(sql) {
  if (typeof sql !== 'string' || sql.trim() === '') {
    throw new SqlValidationError('SQL must be a non-empty string');
  }

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inLineComment = false;
  let inBlockComment = false;
  let statementCount = 0;
  let lastNonWhitespacePos = -1;

  const sqlTrimmed = sql.trimEnd();

  for (let i = 0; i < sqlTrimmed.length; i++) {
    const char = sqlTrimmed[i];
    const nextChar = sqlTrimmed[i + 1];

    // Skip whitespace tracking
    if (!/\s/.test(char)) {
      lastNonWhitespacePos = i;
    }

    // Line comment start (--)
    if (!inSingleQuote && !inDoubleQuote && !inBlockComment && char === '-' && nextChar === '-') {
      inLineComment = true;
      i++;
      continue;
    }

    // Line comment end (newline)
    if (inLineComment && (char === '\n' || char === '\r')) {
      inLineComment = false;
      continue;
    }

    // Skip if in line comment
    if (inLineComment) continue;

    // Block comment start (/*)
    if (!inSingleQuote && !inDoubleQuote && !inLineComment && char === '/' && nextChar === '*') {
      inBlockComment = true;
      i++;
      continue;
    }

    // Block comment end (*/)
    if (inBlockComment && char === '*' && nextChar === '/') {
      inBlockComment = false;
      i++;
      continue;
    }

    // Skip if in block comment
    if (inBlockComment) continue;

    // Single quote handling (escape: '' in SQL)
    if (!inDoubleQuote && char === "'") {
      if (inSingleQuote && nextChar === "'") {
        i++; // escaped quote, skip next
      } else {
        inSingleQuote = !inSingleQuote;
      }
      continue;
    }

    // Double quote handling
    if (!inSingleQuote && char === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    // Semicolon outside strings and comments
    if (!inSingleQuote && !inDoubleQuote && char === ';') {
      statementCount++;
    }
  }

  // If we have a semicolon at the very end, it doesn't count as a separate statement
  const hasTrailingSemicolon = sqlTrimmed[sqlTrimmed.length - 1] === ';';

  if (statementCount > 1 || (statementCount === 1 && !hasTrailingSemicolon)) {
    throw new SqlValidationError('Only one SQL statement is allowed. Please split multiple statements into separate calls.');
  }

  // Return without trailing semicolon
  return hasTrailingSemicolon ? sqlTrimmed.slice(0, -1).trimEnd() : sqlTrimmed;
}

/**
 * Strips leading whitespace and comments from SQL.
 * Skips leading whitespace, -- line comments, and slash-star block comments.
 * @param {string} sql - SQL statement
 * @returns {string} SQL with leading whitespace and comments stripped
 */
function stripLeadingComments(sql) {
  let i = 0;
  const len = sql.length;

  while (i < len) {
    // Skip whitespace
    if (/\s/.test(sql[i])) {
      i++;
      continue;
    }

    // Skip line comment (--)
    if (sql[i] === '-' && sql[i + 1] === '-') {
      i += 2;
      while (i < len && sql[i] !== '\n' && sql[i] !== '\r') {
        i++;
      }
      continue;
    }

    // Skip block comment (/* */)
    if (sql[i] === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < len && !(sql[i] === '*' && sql[i + 1] === '/')) {
        i++;
      }
      i += 2;
      continue;
    }

    break;
  }

  return sql.slice(i);
}

/**
 * Classifies SQL as 'query' or 'update' type.
 * @param {string} sql - SQL statement to classify
 * @returns {string} 'query' or 'update'
 */
export function classifySql(sql) {
  const stripped = stripLeadingComments(sql).toLowerCase();
  const queryKeywords = /^(select|with|show|desc|describe|explain)\b/;
  return queryKeywords.test(stripped) ? 'query' : 'update';
}

/**
 * Formats a SQL validation error result.
 * @param {Error} error - The error object
 * @param {string} [alias] - Optional alias
 * @returns {object} Error result object
 */
export function sqlErrorResult(error, alias) {
  const result = {
    success: false,
    error: {
      type: 'SqlValidationError',
      message: error.message
    }
  };
  if (alias !== undefined) {
    result.alias = alias;
  }
  return result;
}
