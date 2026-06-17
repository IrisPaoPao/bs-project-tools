import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { resolveToolPath } from './config.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const JAVA_DIR = path.resolve(PROJECT_ROOT, 'java');
const JAVA_BUILD_DIR = path.resolve(JAVA_DIR, 'build');
const JDBC_EXECUTOR_SOURCE = path.resolve(JAVA_DIR, 'JdbcExecutor.java');
const JDBC_EXECUTOR_CLASS = path.resolve(JAVA_BUILD_DIR, 'JdbcExecutor.class');

export const javaTimeoutMs = 120000; // 2 minutes

let cachedJavaHome = null;

export function parseJavaMajorVersion(versionOutput) {
  if (!versionOutput || typeof versionOutput !== 'string') {
    return null;
  }

  // Match common Java version output formats:
  // - openjdk version "17.0.10" 2021-10-19
  // - java version "1.8.0_401"
  // - openjdk version "21" 2023-09-19
  // - openjdk 17.0.10 2024-01-16
  // - version 17.0.10
  // First, look for "version" keyword or direct version number at start
  const patterns = [
    // Pattern with "version" keyword (most reliable)
    /version\s+"?(\d+)(?:\.(\d+))?/,
    // Pattern without "version" keyword but with openjdk prefix
    /^openjdk\s+(\d+)(?:\.(\d+))?/m,
    // Pattern for just the version number at start (less reliable)
    /^\s*"?(\d+)(?:\.(\d+))?/
  ];

  for (const pattern of patterns) {
    const match = versionOutput.match(pattern);
    if (match) {
      const major = parseInt(match[1], 10);
      const minor = match[2] ? parseInt(match[2], 10) : 0;

      // Guard against false matches like UTF-8 or other numbers
      // Java versions are reasonable numbers
      if (major < 1 || major > 100) {
        continue;
      }

      // For Java 9+, version is 9.x not 1.9.x
      // For Java 8-, version is 1.8.x
      if (major === 1) {
        // Validate minor version too
        if (minor < 1 || minor > 20) {
          continue;
        }
        return minor; // e.g., 1.8 -> 8
      }
      return major; // e.g., 17.0 -> 17, 21 -> 21
    }
  }

  return null;
}

export function versionOutputAtLeast17(versionOutput) {
  const version = parseJavaMajorVersion(versionOutput);
  return version !== null && version >= 17;
}

async function checkJavaVersion(javaPath) {
  return new Promise((resolve) => {
    const proc = spawn(javaPath, ['-version'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000
    });

    let output = '';
    proc.stderr.on('data', (data) => {
      output += data.toString();
    });
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const version = parseJavaMajorVersion(output);
      resolve(version);
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

async function checkJavaHome(javaHome) {
  if (!javaHome || typeof javaHome !== 'string') return null;

  const java = path.resolve(javaHome, 'bin', 'java');
  const javac = path.resolve(javaHome, 'bin', 'javac');

  if (!fs.existsSync(java) || !fs.existsSync(javac)) {
    return null;
  }

  const version = await checkJavaVersion(java);
  if (version === null || version < 17) {
    return null;
  }

  return javaHome;
}

async function findJavaHomeMacOS() {
  return new Promise((resolve) => {
    const proc = spawn('/usr/libexec/java_home', ['-v', '17+'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10000
    });

    let output = '';
    proc.stdout.on('data', (data) => {
      output += data.toString();
    });

    proc.on('close', async (code) => {
      if (code !== 0) {
        resolve(null);
        return;
      }

      const javaHome = output.trim();
      const result = await checkJavaHome(javaHome);
      resolve(result);
    });

    proc.on('error', () => {
      resolve(null);
    });
  });
}

async function findJavaHomeInPath() {
  // Check common locations
  const commonLocations = [
    '/usr/bin/java',
    '/usr/local/bin/java',
    '/opt/homebrew/bin/java',
    '/Library/Java/JavaVirtualMachines/jdk-17.jdk/Contents/Home',
    '/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home',
    '/usr/lib/jvm/java-17-openjdk-amd64',
    '/usr/lib/jvm/java-21-openjdk-amd64'
  ];

  for (const loc of commonLocations) {
    // If it's a java executable path, get parent dir twice for JAVA_HOME
    let javaHome = loc;
    if (loc.endsWith('/bin/java')) {
      javaHome = path.dirname(path.dirname(loc));
    }
    const result = await checkJavaHome(javaHome);
    if (result) return result;
  }

  // Try 'java' from PATH and try to find JAVA_HOME from it
  try {
    const which = spawn('which', ['java'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 3000 });
    let javaPath = '';
    which.stdout.on('data', (d) => { javaPath += d.toString(); });
    await new Promise((r) => which.on('close', r));
    javaPath = javaPath.trim();

    if (javaPath && fs.existsSync(javaPath)) {
      // Resolve symlinks
      const realJava = fs.realpathSync(javaPath);
      // bin/java -> ../.. = JAVA_HOME
      const javaHome = path.dirname(path.dirname(realJava));
      const result = await checkJavaHome(javaHome);
      if (result) return result;
    }
  } catch (e) {
    // ignore
  }

  return null;
}

export async function findJavaHome() {
  if (cachedJavaHome) {
    return cachedJavaHome;
  }

  // 1. Check JAVA_HOME environment variable
  if (process.env.JAVA_HOME) {
    const result = await checkJavaHome(process.env.JAVA_HOME);
    if (result) {
      cachedJavaHome = result;
      return cachedJavaHome;
    }
  }

  // 2. macOS: use /usr/libexec/java_home
  if (process.platform === 'darwin') {
    const result = await findJavaHomeMacOS();
    if (result) {
      cachedJavaHome = result;
      return cachedJavaHome;
    }
  }

  // 3. Check PATH and common locations
  const result = await findJavaHomeInPath();
  if (result) {
    cachedJavaHome = result;
    return cachedJavaHome;
  }

  throw new Error('Java 17+ is required. Please install Java 17 or later and set JAVA_HOME.');
}

export async function javaBin(binaryName) {
  const javaHome = await findJavaHome();
  return path.resolve(javaHome, 'bin', binaryName);
}

export async function compileExecutor() {
  const sourceMtime = fs.existsSync(JDBC_EXECUTOR_SOURCE)
    ? fs.statSync(JDBC_EXECUTOR_SOURCE).mtimeMs
    : 0;
  const classMtime = fs.existsSync(JDBC_EXECUTOR_CLASS)
    ? fs.statSync(JDBC_EXECUTOR_CLASS).mtimeMs
    : 0;

  // Skip if class file exists and is up-to-date (>= instead of > to handle identical mtimes)
  if (fs.existsSync(JDBC_EXECUTOR_CLASS) && classMtime >= sourceMtime) {
    return;
  }

  // Ensure build directory exists
  if (!fs.existsSync(JAVA_BUILD_DIR)) {
    fs.mkdirSync(JAVA_BUILD_DIR, { recursive: true });
  }

  const javac = await javaBin('javac');

  return new Promise((resolve, reject) => {
    const proc = spawn(javac, [
      '-d', JAVA_BUILD_DIR,
      '-sourcepath', JAVA_DIR,
      JDBC_EXECUTOR_SOURCE
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000
    });

    let stderr = '';
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Failed to compile JdbcExecutor: ${stderr}`));
        return;
      }
      resolve();
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn javac: ${err.message}`));
    });
  });
}

export function buildExecutorRequest({ action, db, options, sql, params, sqlKind, statements, mode }) {
  // Convert driverJars to absolute paths
  const driverJars = db.driverJars.map(jar => resolveToolPath(jar));

  const request = {
    action,
    jdbcUrl: db.jdbcUrl,
    driverClass: db.driverClass,
    driverJars,
    username: db.username,
    password: db.password
  };

  if (action === 'execute') {
    request.sql = sql;
    request.params = params || [];
    request.maxRows = options?.maxRows || 500;
    request.timeoutSeconds = options?.timeoutSeconds || 30;
    request.sqlKind = sqlKind || 'query';
  } else if (action === 'executeBatch') {
    request.statements = statements;
    request.mode = mode || 'abort';
    request.maxRows = options?.maxRows || 500;
    request.timeoutSeconds = options?.timeoutSeconds || 30;
  }

  return request;
}

export async function runExecutor(request, timeoutSeconds) {
  await compileExecutor();

  const java = await javaBin('java');
  const timeout = timeoutSeconds ? timeoutSeconds * 1000 : javaTimeoutMs;

  // Build classpath: java/build + all driver jars
  const classpath = [
    JAVA_BUILD_DIR,
    ...request.driverJars
  ].join(path.delimiter);

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = '';
    let stderr = '';

    const safeResolve = (value) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        resolve(value);
      }
    };

    const safeReject = (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      }
    };

    const proc = spawn(java, [
      '-cp', classpath,
      'JdbcExecutor'
    ], {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Handle timeout with SIGTERM -> SIGKILL sequence
    const timeoutId = setTimeout(() => {
      if (settled) return;

      // First try SIGTERM
      proc.kill('SIGTERM');

      // Give it a short grace period, then SIGKILL if still alive
      setTimeout(() => {
        if (!settled) {
          try {
            proc.kill('SIGKILL');
          } catch (e) {
            // Ignore - process may already be dead
          }
        }
      }, 500);

      safeReject(new Error(`Java executor timed out after ${timeout / 1000} seconds`));
    }, timeout);

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (settled) return;

      // Parse stdout JSON exactly once
      let parsedResult = null;
      try {
        const trimmed = stdout.trim();
        if (trimmed) {
          parsedResult = JSON.parse(trimmed);
        }
      } catch (e) {
        // Not valid JSON, leave as null
      }

      // Handle non-zero exit code
      if (code !== 0) {
        // If stdout contains structured error response, resolve it
        if (parsedResult && parsedResult.success === false && parsedResult.error) {
          safeResolve(parsedResult);
          return;
        }

        // Otherwise, reject with error
        const errorMessage = stderr || `Java process exited with code ${code}`;
        safeReject(new Error(`Executor failed: ${errorMessage}`));
        return;
      }

      // Handle zero exit code
      if (parsedResult !== null) {
        safeResolve(parsedResult);
      } else {
        safeReject(new Error(`Failed to parse executor output: ${stdout.substring(0, 200)}...`));
      }
    });

    proc.on('error', (err) => {
      safeReject(new Error(`Failed to spawn Java process: ${err.message}`));
    });

    // Write request JSON to stdin
    proc.stdin.write(JSON.stringify(request));
    proc.stdin.end();
  });
}

export function executorErrorResult(error, alias) {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof Error ? error.hint : undefined;

  const result = {
    success: false,
    error: {
      type: 'ExecutorError',
      message
    }
  };

  if (alias !== undefined) {
    result.alias = alias;
  }

  if (hint !== undefined) {
    result.error.hint = hint;
  }

  return result;
}
