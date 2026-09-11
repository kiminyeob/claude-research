#!/usr/bin/env node
// MCPB 설치 진단 프로브 — 외부 의존성 없음(Node 내장 모듈만 사용).
// stdout은 JSON-RPC 전용이다. 로그는 전부 stderr로 보낸다.

const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const https = require('https');
const tls = require('tls');

const PROTOCOL_FALLBACK = '2025-06-18';
const UI_EXT = 'io.modelcontextprotocol/ui';
const UI_MIME = 'text/html;profile=mcp-app';
const PANEL_URI = 'ui://mcpb-install-probe/panel';

const startedAt = new Date().toISOString();
const cfg = {
  host: (process.env.PROBE_TARGET_HOST || '').trim(),
  port: Number(process.env.PROBE_TARGET_PORT || 443) || 443,
  path: (process.env.PROBE_TARGET_PATH || '/').trim() || '/',
  secretPresent: Boolean((process.env.PROBE_SECRET || '').trim()),
};

let clientInfo = null;
let clientCapabilities = {};
let negotiatedProtocol = PROTOCOL_FALLBACK;

const log = (...a) => process.stderr.write(`[probe] ${a.join(' ')}\n`);

function uiCapability() {
  const ext = clientCapabilities && clientCapabilities.extensions;
  return ext ? ext[UI_EXT] : undefined;
}

function uiSupported() {
  const cap = uiCapability();
  return Boolean(cap && Array.isArray(cap.mimeTypes) && cap.mimeTypes.includes(UI_MIME));
}

// ---------- 진단 로직 ----------

function envReport() {
  const cap = uiCapability();
  return {
    startedAt,
    now: new Date().toISOString(),
    node: process.version,
    execPath: process.execPath,
    platform: `${process.platform} ${process.arch}`,
    serverDir: process.env.PROBE_DIR || __dirname,
    cwd: process.cwd(),
    host: clientInfo ? `${clientInfo.name} ${clientInfo.version || ''}`.trim() : '(미수신)',
    negotiatedProtocol,
    mcpAppsAdvertised: Boolean(cap),
    mcpAppsMimeTypes: cap && cap.mimeTypes ? cap.mimeTypes : null,
    mcpAppsUsable: uiSupported(),
    clientCapabilityKeys: Object.keys(clientCapabilities || {}),
    userConfig: {
      target_host: cfg.host || '(미입력)',
      target_port: cfg.port,
      target_path: cfg.path,
      // 값 자체는 절대 출력하지 않는다. 전달 여부만 본다.
      secret_probe: cfg.secretPresent ? '(전달됨 — 값은 표시하지 않음)' : '(미입력 또는 미전달)',
    },
    proxyEnv: {
      HTTPS_PROXY: process.env.HTTPS_PROXY || process.env.https_proxy || null,
      HTTP_PROXY: process.env.HTTP_PROXY || process.env.http_proxy || null,
      NO_PROXY: process.env.NO_PROXY || process.env.no_proxy || null,
      NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || null,
    },
  };
}

function dnsStep(host) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err) return resolve({ ok: false, ms: Date.now() - t0, error: err.code || String(err) });
      resolve({ ok: true, ms: Date.now() - t0, addresses: addrs.map((a) => `${a.address} (IPv${a.family})`) });
    });
  });
}

function tcpStep(host, port, timeout = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve({ ...r, ms: Date.now() - t0 }); };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish({ ok: true }));
    sock.once('timeout', () => finish({ ok: false, error: `TIMEOUT (${timeout}ms)` }));
    sock.once('error', (e) => finish({ ok: false, error: e.code || String(e) }));
  });
}

function tlsStep(host, port, timeout = 8000) {
  // 1차: 정상 검증. 실패하면 2차로 검증만 끄고 다시 시도해
  // "도달은 하는데 인증서를 신뢰 못 하는 것"과 "아예 못 닿는 것"을 구분한다.
  const attempt = (rejectUnauthorized) => new Promise((resolve) => {
    const t0 = Date.now();
    const sock = tls.connect({ host, port, servername: host, rejectUnauthorized, timeout });
    let done = false;
    const finish = (r) => { if (done) return; done = true; sock.destroy(); resolve({ ...r, ms: Date.now() - t0 }); };
    sock.once('secureConnect', () => {
      const cert = sock.getPeerCertificate() || {};
      finish({
        ok: true,
        authorized: sock.authorized,
        authorizationError: sock.authorizationError ? String(sock.authorizationError) : null,
        protocol: sock.getProtocol(),
        subject: cert.subject && cert.subject.CN ? cert.subject.CN : null,
        issuer: cert.issuer && cert.issuer.CN ? cert.issuer.CN : null,
        validTo: cert.valid_to || null,
      });
    });
    sock.once('timeout', () => finish({ ok: false, error: `TIMEOUT (${timeout}ms)` }));
    sock.once('error', (e) => finish({ ok: false, error: e.code || String(e) }));
  });

  return attempt(true).then((strict) => {
    if (strict.ok) return { strict };
    return attempt(false).then((lenient) => ({ strict, lenient }));
  });
}

function httpsStep(host, port, reqPath, timeout = 8000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      { host, port, path: reqPath, method: 'GET', timeout, rejectUnauthorized: false, headers: { 'User-Agent': 'mcpb-install-probe/0.1' } },
      (res) => {
        res.resume();
        resolve({ ok: true, ms: Date.now() - t0, status: res.statusCode, server: res.headers.server || null, location: res.headers.location || null });
      }
    );
    req.once('timeout', () => { req.destroy(); resolve({ ok: false, ms: Date.now() - t0, error: `TIMEOUT (${timeout}ms)` }); });
    req.once('error', (e) => resolve({ ok: false, ms: Date.now() - t0, error: e.code || String(e) }));
    req.end();
  });
}

async function networkReport(host, port, reqPath) {
  if (!host) return { skipped: true, reason: '대상 호스트가 입력되지 않았습니다. 확장 설정에서 호스트를 입력하세요.' };
  const out = { host, port, path: reqPath };
  out.dns = await dnsStep(host);
  if (!out.dns.ok) return out;
  out.tcp = await tcpStep(host, port);
  if (!out.tcp.ok) return out;
  if (port === 443 || port === 8443) {
    out.tls = await tlsStep(host, port);
    out.https = await httpsStep(host, port, reqPath);
  }
  return out;
}

function verdict(n) {
  if (n.skipped) return '건너뜀 — 호스트 미입력';
  if (!n.dns || !n.dns.ok) return `❌ DNS 실패 (${n.dns && n.dns.error}) — 사내 DNS를 못 쓰거나 호스트명이 틀립니다`;
  if (!n.tcp || !n.tcp.ok) return `❌ TCP 실패 (${n.tcp && n.tcp.error}) — 이름은 풀리는데 연결이 막혀 있습니다`;
  if (n.tls && n.tls.strict && !n.tls.strict.ok && n.tls.lenient && n.tls.lenient.ok) {
    return '⚠️ 연결은 되지만 TLS 인증서를 신뢰하지 못합니다 — 사내 프록시/사설 CA일 가능성. NODE_EXTRA_CA_CERTS 필요';
  }
  if (n.https && n.https.ok) return `✅ 도달 가능 — HTTPS ${n.https.status}`;
  if (n.tcp.ok) return '✅ TCP 도달 가능 (HTTPS 응답은 확인 못 함)';
  return '판정 불가';
}

// ---------- 출력 포맷 ----------

function renderText() {
  const e = envReport();
  const L = [];
  L.push('# MCPB 설치 진단 결과');
  L.push('');
  L.push('## 1. 설치·기동');
  L.push('이 결과가 보인다는 것 자체가 다음을 의미합니다:');
  L.push('- ✅ `.mcpb` 번들이 조직 정책상 설치되었다');
  L.push('- ✅ Claude Desktop이 stdio MCP 서버를 기동했다');
  L.push(`- ✅ Node 런타임 동작: ${e.node} (${e.platform})`);
  L.push(`- 실행 경로: \`${e.execPath}\``);
  L.push(`  → 경로가 Claude 앱 내부면 **동봉 Node**를 쓴 것이고, 시스템 경로면 PC에 설치된 Node를 쓴 것입니다.`);
  L.push('');
  L.push('## 2. 호스트·프로토콜');
  L.push(`- 호스트: ${e.host}`);
  L.push(`- 협상된 프로토콜 버전: ${e.negotiatedProtocol}`);
  L.push(`- 클라이언트 capability 키: ${e.clientCapabilityKeys.join(', ') || '(없음)'}`);
  L.push('');
  L.push('## 3. MCP Apps (ui://) 지원 여부');
  L.push(`- 호스트가 \`${UI_EXT}\` 확장을 광고했는가: **${e.mcpAppsAdvertised ? '예 ✅' : '아니오 ❌'}**`);
  L.push(`- 지원 MIME: ${e.mcpAppsMimeTypes ? e.mcpAppsMimeTypes.join(', ') : '(없음)'}`);
  L.push(`- \`${UI_MIME}\` 사용 가능: **${e.mcpAppsUsable ? '예 ✅' : '아니오 ❌'}**`);
  if (!e.mcpAppsAdvertised) {
    L.push('');
    L.push('> ⚠️ 광고되지 않았다면 이 버전의 Desktop이 MCP Apps를 아직 협상하지 않는 것입니다.');
    L.push('> 그래도 아래 패널이 화면에 그려진다면 구현이 스펙보다 앞서 있는 것이니 둘 다 기록해 두세요.');
  }
  L.push('');
  L.push('## 4. user_config 전달');
  L.push(`- 대상 호스트: \`${e.userConfig.target_host}\``);
  L.push(`- 포트: ${e.userConfig.target_port} · 경로: \`${e.userConfig.target_path}\``);
  L.push(`- sensitive 값: ${e.userConfig.secret_probe}`);
  L.push('');
  L.push('## 5. 프록시·CA 환경변수');
  const p = e.proxyEnv;
  L.push(`- HTTPS_PROXY: ${p.HTTPS_PROXY || '(미설정)'}`);
  L.push(`- HTTP_PROXY: ${p.HTTP_PROXY || '(미설정)'}`);
  L.push(`- NO_PROXY: ${p.NO_PROXY || '(미설정)'}`);
  L.push(`- NODE_EXTRA_CA_CERTS: ${p.NODE_EXTRA_CA_CERTS || '(미설정)'}`);
  L.push('');
  L.push('> 다음: `probe_network` 도구를 실행해 사내망 도달성을 확인하세요.');
  return L.join('\n');
}

function renderNetwork(n) {
  const L = [];
  L.push('# 사내망 도달성 검사');
  L.push('');
  L.push(`**판정: ${verdict(n)}**`);
  L.push('');
  if (n.skipped) { L.push(n.reason); return L.join('\n'); }
  L.push(`대상: \`${n.host}:${n.port}${n.path}\``);
  L.push('');
  L.push('| 단계 | 결과 | 소요 | 상세 |');
  L.push('|---|---|---|---|');
  const row = (name, r, detail) => L.push(`| ${name} | ${r ? (r.ok ? '✅' : '❌') : '—'} | ${r && r.ms != null ? r.ms + 'ms' : '—'} | ${detail || (r && r.error) || ''} |`);
  row('DNS', n.dns, n.dns && n.dns.ok ? n.dns.addresses.join(', ') : null);
  row('TCP', n.tcp, null);
  if (n.tls) {
    const s = n.tls.strict;
    if (s.ok) row('TLS (검증)', s, `${s.protocol} · CN=${s.subject} · 발급 ${s.issuer} · 만료 ${s.validTo}`);
    else {
      row('TLS (검증)', s, null);
      if (n.tls.lenient) row('TLS (검증 생략)', n.tls.lenient, n.tls.lenient.ok ? `발급 ${n.tls.lenient.issuer} — 이 발급자가 사내 CA면 프록시 개입입니다` : null);
    }
  }
  if (n.https) row('HTTPS GET', n.https, n.https.ok ? `HTTP ${n.https.status}${n.https.server ? ' · ' + n.https.server : ''}` : null);
  L.push('');
  L.push('해석:');
  L.push('- DNS까지 실패 → 이 PC가 사내 DNS를 안 보고 있거나 호스트명이 다릅니다.');
  L.push('- DNS 성공 + TCP 실패 → 이름은 풀리는데 방화벽/세그먼트에서 막힙니다.');
  L.push('- TCP 성공 + TLS 검증만 실패 → 사내 사설 CA입니다. 서버에 `NODE_EXTRA_CA_CERTS`로 CA를 물려야 합니다.');
  L.push('- 전부 성공 → **로컬 stdio MCP 서버가 사내 TX360에 직접 닿습니다.** 터널 없이 갑니다.');
  return L.join('\n');
}

// ---------- 도구 정의 ----------

function toolDefs() {
  const uiMeta = (visibility) => ({ ui: { resourceUri: PANEL_URI, visibility } });
  return [
    {
      name: 'probe_report',
      description: '설치·기동·런타임·MCP Apps 협상·user_config 전달 상태를 보고한다. 설치 직후 가장 먼저 실행할 것.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: uiMeta(['model', 'app']),
    },
    {
      name: 'probe_network',
      description: '설정된 사내 호스트에 DNS → TCP → TLS → HTTPS 순으로 도달성을 검사한다. 외부로 데이터를 보내지 않는다.',
      inputSchema: {
        type: 'object',
        properties: {
          host: { type: 'string', description: '검사할 호스트명. 생략하면 확장 설정값을 쓴다.' },
          port: { type: 'number', description: '포트. 생략하면 확장 설정값을 쓴다.' },
          path: { type: 'string', description: 'HTTPS 경로. 생략하면 확장 설정값을 쓴다.' },
        },
        additionalProperties: false,
      },
      _meta: uiMeta(['model', 'app']),
    },
    {
      name: 'probe_app_only',
      description: 'visibility가 ["app"]인 도구. 모델의 도구 목록에는 보이면 안 되고, UI 패널에서만 호출돼야 한다.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      _meta: uiMeta(['app']),
    },
  ];
}

function textResult(text, structured) {
  const r = { content: [{ type: 'text', text }] };
  if (structured) r.structuredContent = structured;
  return r;
}

async function callTool(name, args) {
  args = args || {};
  if (name === 'probe_report') {
    return textResult(renderText(), envReport());
  }
  if (name === 'probe_network') {
    const host = (args.host || cfg.host || '').trim();
    const port = Number(args.port || cfg.port) || 443;
    const reqPath = (args.path || cfg.path || '/').trim() || '/';
    const n = await networkReport(host, port, reqPath);
    return textResult(renderNetwork(n), { verdict: verdict(n), detail: n });
  }
  if (name === 'probe_app_only') {
    const stamp = new Date().toISOString();
    return textResult(
      `✅ app-only 도구가 호출되었습니다 (${stamp}).\n\n이 도구가 모델의 도구 목록에 보이지 않았다면 호스트가 \`visibility: ["app"]\`을 올바르게 처리한 것입니다.`,
      { calledAt: stamp }
    );
  }
  const err = new Error(`Unknown tool: ${name}`);
  err.code = -32602;
  throw err;
}

// ---------- 리소스 ----------

function targetOrigin() {
  if (!cfg.host) return '';
  return `https://${cfg.host}${cfg.port === 443 ? '' : ':' + cfg.port}`;
}

function panelHtml() {
  const html = fs.readFileSync(path.join(__dirname, 'panel.html'), 'utf8');
  // 사내 호스트명은 번들에 하드코딩하지 않는다. 설치 시 입력된 값을 읽기 직전에 주입한다.
  const inject = `<script>window.__PROBE_CFG__=${JSON.stringify({ origin: targetOrigin(), host: cfg.host })};</script>`;
  return html.replace('</head>', `${inject}\n</head>`);
}

function panelMeta() {
  const csp = {};
  const origin = targetOrigin();
  if (origin) {
    // iframe이 사내망 오리진에 직접 닿는지 확인하기 위해 선언한다.
    csp.connectDomains = [origin];
    csp.resourceDomains = [origin];
  }
  const ui = { prefersBorder: true };
  if (Object.keys(csp).length) ui.csp = csp;
  return { ui };
}

function resourceDefs() {
  return [{ uri: PANEL_URI, name: 'MCPB 진단 패널', description: 'MCP Apps 렌더링 확인용 패널', mimeType: UI_MIME }];
}

// ---------- JSON-RPC 배선 ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) { send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  switch (method) {
    case 'initialize': {
      clientInfo = (params && params.clientInfo) || null;
      clientCapabilities = (params && params.capabilities) || {};
      negotiatedProtocol = (params && params.protocolVersion) || PROTOCOL_FALLBACK;
      log(`initialize from ${clientInfo && clientInfo.name} proto=${negotiatedProtocol} ui=${uiSupported()}`);
      return reply(id, {
        protocolVersion: negotiatedProtocol,
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false, subscribe: false },
          extensions: { [UI_EXT]: { mimeTypes: [UI_MIME] } },
        },
        serverInfo: { name: 'mcpb-install-probe', version: '0.1.0' },
        instructions: '설치 직후 probe_report를 먼저 실행하고, 그다음 probe_network를 실행하세요.',
      });
    }
    case 'notifications/initialized':
    case 'initialized':
      return;
    case 'ping':
      return isRequest && reply(id, {});
    case 'tools/list':
      return reply(id, { tools: toolDefs() });
    case 'tools/call': {
      const nm = params && params.name;
      try {
        const result = await callTool(nm, params && params.arguments);
        return reply(id, result);
      } catch (e) {
        log(`tool error ${nm}: ${e.stack || e}`);
        return reply(id, { content: [{ type: 'text', text: `도구 실행 실패: ${e.message}` }], isError: true });
      }
    }
    case 'resources/list':
      return reply(id, { resources: resourceDefs() });
    case 'resources/templates/list':
      return reply(id, { resourceTemplates: [] });
    case 'resources/read': {
      const uri = params && params.uri;
      if (uri !== PANEL_URI) return replyError(id, -32602, `Unknown resource: ${uri}`);
      return reply(id, { contents: [{ uri: PANEL_URI, mimeType: UI_MIME, text: panelHtml(), _meta: panelMeta() }] });
    }
    case 'prompts/list':
      return reply(id, { prompts: [] });
    default:
      if (isRequest) return replyError(id, -32601, `Method not found: ${method}`);
  }
}

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log(`parse error: ${e.message}`); continue; }
    Promise.resolve(handle(msg)).catch((e) => log(`handler error: ${e.stack || e}`));
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (e) => log(`uncaught: ${e.stack || e}`));

log(`started pid=${process.pid} node=${process.version} host=${cfg.host || '(none)'}`);
