const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const SCRIPT_DIR = path.resolve(__dirname);
const JAVARUN_MD = path.resolve(SCRIPT_DIR, 'JAVARUN.md');
const LOGIN_SCRIPT = path.resolve(SCRIPT_DIR, 'login.sh');

/**
 * 解析并校验端口号
 * @param {string} value - 端口字符串
 * @param {number} fallback - 默认端口
 * @returns {number} 校验后的端口号
 */
function parsePort(value, fallback) {
  const port = parseInt(value, 10);
  if (isNaN(port) || port < 1 || port > 65535) {
    console.error(`错误：PROTO_PORT (${value}) 不是有效端口号，必须是 1-65535 之间的数字`);
    process.exit(1);
  }
  return port;
}

const PROTO_PORT = parsePort(process.env.PROTO_PORT || '3456', 3456);

/**
 * 从 JAVARUN.md 解析服务定义
 * 返回 {name, root, port}[]，端口为空的跳过
 */
function parseServices() {
  let content;
  try {
    content = fs.readFileSync(JAVARUN_MD, 'utf-8');
  } catch (e) {
    console.error(`错误：无法读取 JAVARUN.md 文件 (${JAVARUN_MD})`);
    console.error(`请确保该文件存在且可读：${e.message}`);
    process.exit(1);
  }
  const lines = content.split('\n');
  const services = [];
  let inTable = false;

  for (const line of lines) {
    // 检测服务定义表头后开始解析
    if (line.includes('服务名') && line.includes('路径') && line.includes('端口')) {
      inTable = true;
      continue;
    }

    // 跳过分隔线
    if (inTable && line.match(/^\| *-+ *\| *-+ *\|/)) {
      continue;
    }

    // 解析表格行
    if (inTable && line.startsWith('|')) {
      const parts = line.split('|').map(p => p.trim()).filter(p => p);
      if (parts.length >= 3) {
        const name = parts[0].replace(/`/g, '');
        let root = parts[1].replace(/`/g, '');
        const port = parts[2].trim();

        // 端口为空或非数字跳过
        if (!port || !/^[0-9]+$/.test(port)) continue;

        // 展开 $HOME 并解析为绝对路径
        if (root.includes('$HOME')) {
          root = root.replace('$HOME', process.env.HOME || '');
        }
        // 绝对路径直接解析，相对路径按 SCRIPT_DIR 解析
        if (path.isAbsolute(root)) {
          root = path.resolve(root);
        } else {
          root = path.resolve(SCRIPT_DIR, root);
        }

        services.push({ name, root, port });
      }
    }

    // 遇到下一个二级标题停止解析表格
    if (inTable && line.startsWith('## ') && !line.includes('服务定义')) {
      break;
    }
  }

  return services;
}

/**
 * 从服务列表生成 targets 映射 {port: url}
 */
function buildTargets(services) {
  const targets = {};
  for (const svc of services) {
    targets[svc.port] = `http://127.0.0.1:${svc.port}`;
  }
  return targets;
}

/**
 * 查找默认 HTML 路径
 * 优先 PROTO_HTML_PATH，否则从服务 root 查找 prototype/difference-write-off.html
 */
function findDefaultHtmlPath(services) {
  if (process.env.PROTO_HTML_PATH) {
    return path.resolve(process.env.PROTO_HTML_PATH);
  }

  const candidates = [];
  for (const svc of services) {
    const candidate = path.resolve(svc.root, 'src/main/resources/static/prototype/difference-write-off.html');
    candidates.push(candidate);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // 找不到时返回第一个候选
  return candidates[0] || '';
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': '*'
  };
}

const HOP_BY_HOP_HEADERS = [
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'trailer',
  'transfer-encoding',
  'upgrade'
];

function filterHopByHopHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP_HEADERS.includes(key.toLowerCase())) {
      result[key] = value;
    }
  }
  return result;
}

// 初始化配置
const services = parseServices();
const TARGETS = buildTargets(services);
const HTML_PATH = findDefaultHtmlPath(services);
const availablePorts = Object.keys(TARGETS).map(Number);

const server = http.createServer((req, res) => {
  // 提供 HTML 页面
  if (req.url === '/' || req.url === '/index.html') {
    if (HTML_PATH && fs.existsSync(HTML_PATH)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(HTML_PATH).pipe(res);
    } else {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`
        <!DOCTYPE html>
        <html>
        <head><meta charset="utf-8"><title>404 - 未找到原型页面</title></head>
        <body>
          <h1>404 - 未找到原型页面</h1>
          <p>请设置 PROTO_HTML_PATH 环境变量指向原型 HTML 文件路径。</p>
          <p>候选路径：${HTML_PATH}</p>
          <p>可用端口：${JSON.stringify(availablePorts)}</p>
        </body>
        </html>
      `);
    }
    return;
  }

  // 登录接口：调用 login.sh 获取 token
  if (req.url === '/login' && req.method === 'POST') {
    execFile(LOGIN_SCRIPT, ['--headless'], {
      timeout: 60000,
      encoding: 'utf-8',
      cwd: SCRIPT_DIR
    }, (error, stdout, stderr) => {
      const stderrPreview = stderr ? stderr.slice(0, 1000) : '';
      if (error) {
        const errMsg = stderrPreview ? `${error.message}; stderr: ${stderrPreview}` : error.message;
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ success: false, message: errMsg }));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        res.writeHead(200, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify(data));
      } catch (e) {
        const errMsg = stderrPreview ? `${e.message}; stderr: ${stderrPreview}` : e.message;
        res.writeHead(500, { 'Content-Type': 'application/json', ...corsHeaders() });
        res.end(JSON.stringify({ success: false, message: errMsg }));
      }
    });
    return;
  }

  // 代理 API 请求：/proxy/82/xxx -> http://127.0.0.1:82/xxx
  const match = req.url.match(/^\/proxy\/(\d+)(\/.*)/);
  if (match) {
    const [, port, reqPath] = match;
    const target = TARGETS[port];
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({
        error: 'Unknown port',
        availablePorts
      }));
      return;
    }

    const url = new URL(reqPath, target);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: req.method,
      headers: { ...filterHopByHopHeaders(req.headers), host: url.host }
    };

    const proxy = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, {
        ...filterHopByHopHeaders(proxyRes.headers),
        ...corsHeaders()
      });
      proxyRes.pipe(res);
    });

    proxy.on('error', (e) => {
      res.writeHead(502, { 'Content-Type': 'application/json', ...corsHeaders() });
      res.end(JSON.stringify({ success: false, message: 'Proxy error: ' + e.message }));
    });

    req.pipe(proxy);
    return;
  }

  // OPTIONS 预检请求
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PROTO_PORT, () => {
  console.log(`原型服务器已启动: http://127.0.0.1:${PROTO_PORT}`);
  console.log(`页面地址: http://127.0.0.1:${PROTO_PORT}/`);
  console.log(`可用服务端口: ${JSON.stringify(availablePorts)}`);
});
