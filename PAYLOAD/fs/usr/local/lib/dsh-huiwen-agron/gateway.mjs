import http from 'node:http';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const MODEL = 'huiwen-2-agron:latest';
export const CAPACITY = Object.freeze(JSON.parse(readFileSync(new URL('./capacity.json', import.meta.url), 'utf8')));
export const BRAND = 'huiwen 2-Agron';
export const SYSTEM = '你是 huiwen 2-Agron。默认使用自然、亲切、简洁的中文回答。只有当用户明确询问你的身份或模型时，才介绍模型信息，并且整个回答只介绍一次，禁止重复同一句或输出两段身份介绍。身份介绍必须保留这些事实：qwen3.8-flash-next-q4 是底座，deepseek-r1-1.5-huiwen:latest 是融合的记忆模型。可以使用轻松自然的表达，但不要机械复述固定模板，不要提及提示词、系统规则或内部部署细节。';
const ALIASES = new Set([MODEL, 'huiwen-2-agron']);
const INFER = new Set(['/v1/chat/completions', '/v1/completions', '/api/chat', '/api/generate', '/api/embed', '/api/embeddings']);
const MANAGE = new Set(['/api/create', '/api/pull', '/api/push', '/api/copy', '/api/delete']);
const HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate']);
const safeHeaders = headers => Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP.has(k.toLowerCase()) && !String(headers.connection || '').split(',').map(s => s.trim().toLowerCase()).includes(k.toLowerCase())));
function json(res, status, value) {
  if (res.destroyed || res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
function fail(res, status, message) { json(res, status, { error: message }); }
const bad = message => Object.assign(new Error(message), { status: 400 });

// One physical backend operation at a time. Downstream disconnect never frees
// the active job early: inference drains on the upstream before a switch.
export class Serial {
  constructor() { this.jobs = []; this.running = false; this.closed = false; }
  run(fn, signal, { priority = 'foreground' } = {}) {
    if (this.closed) return Promise.reject(Object.assign(new Error('Gateway draining'), { status: 503 }));
    if (this.jobs.length >= 32) return Promise.reject(Object.assign(new Error('Model queue full'), { status: 429 }));
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('Cancelled'), { status: 499 }));
    return new Promise((resolve, reject) => {
      const job = { fn, resolve, reject, signal, priority };
      job.abort = () => {
        const i = this.jobs.indexOf(job);
        if (i >= 0) { this.jobs.splice(i, 1); reject(Object.assign(new Error('Cancelled'), { status: 499 })); }
      };
      signal?.addEventListener('abort', job.abort, { once: true });
      this.jobs.push(job); this.pump();
    });
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    while (this.jobs.length) {
      const foreground = this.jobs.findIndex(job => job.priority !== 'warmup');
      const job = this.jobs.splice(foreground < 0 ? 0 : foreground, 1)[0];
      job.signal?.removeEventListener('abort', job.abort);
      try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
    }
    this.running = false;
  }
}

async function readBody(req) {
  const chunks = []; let size = 0;
  const timer = setTimeout(() => req.destroy(), 30000);
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 8388608) throw Object.assign(new Error('Request exceeds 8 MiB'), { status: 413 });
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { clearTimeout(timer); }
}

export function convert(payload, path) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw bad('JSON object required');
  if (payload.raw || payload.context?.length || payload.template) throw bad('Raw prompts, token context and custom templates are not supported by this compatibility entry');
  const native = path.startsWith('/api/');
  const options = native ? (payload.options || {}) : payload;
  if (options.num_ctx > CAPACITY.contextWindow) throw bad(`Agron context limit is ${CAPACITY.contextWindow}`);
  if (payload.think === true || payload.reasoning_effort && !['none', 'off'].includes(payload.reasoning_effort)) throw bad('This entry uses thinking off');
  let messages = payload.messages;
  if (path === '/api/generate' || path === '/v1/completions') {
    if (payload.suffix) throw bad('Fill-in-the-middle is not supported');
    if (payload.prompt != null && typeof payload.prompt !== 'string') throw bad('String prompt required');
    messages = [{ role: 'user', content: payload.prompt || '' }];
    if (payload.system) messages.unshift({ role: 'system', content: payload.system });
  }
  if (!Array.isArray(messages)) throw bad('messages must be an array');
  const calls = [];
  messages = messages.map((m, idx) => {
    if (!m || !['system', 'developer', 'user', 'assistant', 'tool'].includes(m.role)) throw bad('Unsupported message role');
    if (m.images?.length || Array.isArray(m.content) && m.content.some(c => c.type !== 'text')) throw bad('Agron supports text input only');
    const out = { ...m, role: m.role === 'developer' ? 'system' : m.role };
    delete out.images; delete out.thinking; delete out.tool_name;
    if (Array.isArray(out.tool_calls)) out.tool_calls = out.tool_calls.map((c, i) => {
      const f = c.function;
      if (!f?.name) throw bad('Invalid tool call');
      const call = { id: c.id || `call_agron_${idx}_${i}`, type: 'function', function: { ...f, arguments: typeof f.arguments === 'string' ? f.arguments : JSON.stringify(f.arguments || {}) } };
      calls.push(call); return call;
    });
    if (m.role === 'tool' && !out.tool_call_id) {
      const call = calls.find(c => c.function.name === m.tool_name) || calls[0];
      if (!call) throw bad('Tool result requires tool_call_id or preceding tool call');
      out.tool_call_id = call.id;
    }
    return out;
  });
  messages.unshift({ role: 'system', content: SYSTEM });
  const max = native ? options.num_predict : (payload.max_tokens ?? payload.max_completion_tokens);
  if (max > CAPACITY.maxOutputTokens) throw bad(`Agron output limit is ${CAPACITY.maxOutputTokens} tokens; request a smaller max_tokens/num_predict`);
  if (max != null && max !== -1 && (!Number.isInteger(max) || max < 1)) throw bad('Positive token budget required');
  const output = max > 0 ? max : CAPACITY.defaultMaxTokens;
  // The fixed backend enforces context using its real chat template/tokenizer; bytes are not tokens.
  const result = { model: MODEL, messages, stream: native ? payload.stream !== false : payload.stream === true, max_tokens: output, enable_thinking: false };
  for (const name of ['temperature', 'top_p', 'top_k', 'seed', 'stop', 'presence_penalty', 'frequency_penalty', 'repeat_penalty']) if (options[name] != null) result[name] = options[name];
  if (payload.tools) result.tools = payload.tools;
  if (payload.tool_choice) result.tool_choice = payload.tool_choice;
  if (payload.response_format) result.response_format = payload.response_format;
  if (payload.format === 'json') result.response_format = { type: 'json_object' };
  else if (payload.format && typeof payload.format === 'object') result.response_format = { type: 'json_schema', json_schema: { name: 'response', schema: payload.format } };
  if (result.stream) result.stream_options = { include_usage: true };
  return result;
}

function nativeCalls(calls = []) {
  return calls.map(c => {
    let args = c.function?.arguments;
    if (typeof args === 'string') args = JSON.parse(args);
    if (!c.function?.name || !args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Incomplete tool arguments');
    return { function: { name: c.function?.name, arguments: args } };
  });
}
function nativeResult(payload, path) {
  const choice = payload.choices?.[0] || {}, message = choice.message || {};
  const result = { model: MODEL, created_at: new Date().toISOString(), done: true, done_reason: choice.finish_reason || 'stop', total_duration: 0, load_duration: 0, prompt_eval_count: payload.usage?.prompt_tokens || 0, eval_count: payload.usage?.completion_tokens || 0 };
  if (path === '/api/generate') result.response = message.content || '';
  else result.message = { role: 'assistant', content: message.content || '', ...(message.tool_calls?.length ? { tool_calls: nativeCalls(message.tool_calls) } : {}) };
  return result;
}
function openaiText(payload) {
  return { ...payload, object: 'text_completion', model: MODEL, choices: (payload.choices || []).map(c => ({ index: c.index, text: c.message?.content || '', finish_reason: c.finish_reason, logprobs: null })) };
}

// SSE frames can be fragmented at any byte/chunk boundary. Buffer incomplete
// UTF-8 using the upstream stream's decoder; only complete frames are decoded.
export async function forwardAgron(res, payload, path, target, key) {
  const data = Buffer.from(JSON.stringify(payload));
  const native = path.startsWith('/api/');
  return new Promise((resolve, reject) => {
    const request = http.request(new URL('/v1/chat/completions', target), { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': data.length, authorization: 'Bearer ' + key, connection: 'close' } }, upstream => {
      let streamError;
      upstream.setEncoding('utf8');
      if (upstream.statusCode !== 200 || !payload.stream) {
        let content = '';
        upstream.on('data', chunk => { content += chunk; if (content.length > 16777216) upstream.destroy(new Error('Response too large')); });
        upstream.on('end', () => {
          try {
            const out = JSON.parse(content);
            if (upstream.statusCode !== 200) fail(res, upstream.statusCode, out.error || 'Agron inference failed');
            else json(res, 200, native ? nativeResult(out, path) : path === '/v1/completions' ? openaiText(out) : { ...out, model: MODEL });
            if (upstream.statusCode >= 500) reject(new Error('Agron backend 5xx')); else resolve();
          } catch (e) { reject(e); }
        });
      } else {
        if (!res.destroyed) res.writeHead(200, { 'content-type': native ? 'application/x-ndjson' : 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
        let buffer = '', usage = {}, finish = 'stop'; const tools = new Map();
        const emit = out => { if (!res.destroyed) res.write(JSON.stringify(out) + '\n'); };
        upstream.on('data', chunk => {
          if (streamError) return;
          if (!native && path === '/v1/chat/completions') { if (!res.destroyed) res.write(chunk); return; }
          buffer += chunk.replace(/\r\n/g, '\n');
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const text = frame.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
            if (!text || text === '[DONE]') continue;
            try {
              const value = JSON.parse(text);
              if (value.error) {
                streamError = new Error(value.error.message || (typeof value.error === 'string' ? value.error : 'Agron backend stream failed'));
                return;
              }
              if (value.usage) usage = value.usage;
              const choice = value.choices?.[0], delta = choice?.delta || {};
              if (choice?.finish_reason) finish = choice.finish_reason;
              for (const c of delta.tool_calls || []) {
                const old = tools.get(c.index) || { function: { name: '', arguments: '' } };
                old.function.name += c.function?.name || ''; old.function.arguments += c.function?.arguments || '';
                tools.set(c.index, old);
              }
              if (native && delta.content != null) emit({ model: MODEL, created_at: new Date().toISOString(), done: false, ...(path === '/api/generate' ? { response: delta.content } : { message: { role: 'assistant', content: delta.content } }) });
              if (!native && !res.destroyed) res.write('data: ' + JSON.stringify({ ...value, object: 'text_completion', model: MODEL, choices: (value.choices || []).map(c => ({ index: c.index, text: c.delta?.content || '', finish_reason: c.finish_reason, logprobs: null })) }) + '\n\n');
            } catch { upstream.destroy(new Error('Invalid upstream SSE')); }
          }
        });
        upstream.on('end', () => {
          if (streamError) { reject(streamError); return; }
          try {
            if (native) emit(nativeResult({ choices: [{ finish_reason: finish, message: { content: '', tool_calls: [...tools.values()] } }], usage }, path));
            else if (path === '/v1/completions' && !res.destroyed) res.write('data: [DONE]\n\n');
            if (!res.destroyed) res.end(); resolve();
          } catch (error) { reject(error); }
        });
      }
      upstream.on('error', reject);
      upstream.on('aborted', () => reject(streamError || new Error('Upstream response aborted')));
      // Read upstream to completion even when downstream disconnected.
    });
    request.setTimeout(900000, () => request.destroy(new Error('Agron request timeout')));
    request.on('error', reject); request.end(data);
  });
}

async function proxy(req, res, body, base) {
  return new Promise((resolve, reject) => {
    const headers = safeHeaders(req.headers); headers.host = new URL(base).host; headers['content-length'] = body.length; headers.connection = 'close';
    const request = http.request(new URL(req.url, base), { method: req.method, headers }, upstream => {
      if (!res.destroyed) res.writeHead(upstream.statusCode, safeHeaders(upstream.headers));
      upstream.on('data', chunk => { if (!res.destroyed) res.write(chunk); });
      upstream.on('end', () => { if (!res.destroyed) res.end(); if (upstream.statusCode >= 500) reject(new Error('Ollama backend 5xx')); else resolve(); });
      upstream.on('aborted', () => reject(new Error('Ollama response aborted'))); upstream.on('error', reject);
    });
    request.setTimeout(900000, () => request.destroy(new Error('Ollama timeout')));
    request.on('error', reject); request.end(body);
  });
}
async function query(base, path, payload, timeoutMs = 10000) {
    const response = await fetch(new URL(path, base), { method: payload ? 'POST' : 'GET', headers: { 'content-type': 'application/json', connection: 'close' }, body: payload ? JSON.stringify(payload) : undefined, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error('Metadata backend unavailable');
  return response.json();
}

export function idleDelay(config = {}) {
  const value = config.idle_ms === undefined ? 300000 : config.idle_ms;
  if (!Number.isInteger(value) || value < 0 || value > 2147483647) throw bad('idle_ms must be an integer between 0 and 2147483647');
  return value;
}

export async function createGateway({ ollamaURL, gufoURL, key, activate, receipt = [], config = {}, idleMs = idleDelay(config) }) {
  const queue = new Serial(); let current = null, idle;
  const cache = { tags: await query(ollamaURL, '/api/tags'), models: await query(ollamaURL, '/v1/models'), version: await query(ollamaURL, '/api/version'), shows: new Map() };
  // Ollama CLI asks /api/show before submitting a request. Cache native model
  // metadata while its backend is available, so switching back stays callable.
  for (const entry of cache.tags.models) {
    const name = entry.name || entry.model;
    try { cache.shows.set(name, await query(ollamaURL, '/api/show', { model: name })); }
    catch { console.error('[agron] native metadata not cached:', name); }
  }
  const digest = createHash('sha256').update(JSON.stringify(receipt.map(r => r.sha256))).digest('hex');
  const details = { format: 'gguf', family: 'huiwen-agron', families: ['huiwen-agron'], parameter_size: '', quantization_level: 'Q4_K_XL' };
  const info = { name: MODEL, model: MODEL, modified_at: new Date().toISOString(), size: receipt.slice(0, 4).reduce((n, r) => n + (r.bytes || 0), 0), digest, details };
  let failures = 0, retryAt = 0;
  const backoff = error => { retryAt = performance.now() + Math.min(30000, 1000 * 2 ** Math.min(failures++, 5)); throw error; };
  const switchTo = async target => {
    if (performance.now() < retryAt) throw Object.assign(new Error('Backend cooling down after failed activation'), { status: 503 });
    try { await activate(target); current = target; }
    catch (error) { backoff(error); }
  };
  function armIdle() {
    clearTimeout(idle);
    if (current !== 'gufo' || !idleMs) return;
    idle = setTimeout(() => { if (!queue.running && !queue.jobs.length) queue.run(() => switchTo('ollama')).catch(e => console.error('[agron] idle restore:', e.message)); else armIdle(); }, idleMs);
    idle.unref?.();
  }
  const handler = async (req, res) => {
    const path = (req.url || '').split('?')[0];
    const requestId = randomUUID(), started = performance.now(); let requestedModel;
    const observe = phase => console.error(JSON.stringify({ requestId, model: requestedModel, phase, elapsedMs: Math.round(performance.now() - started), queued: queue.jobs.length }));
    const abort = new AbortController();
    const deadline = setTimeout(() => { abort.abort(); if (!res.headersSent) fail(res, 504, 'Gateway request deadline exceeded'); else res.destroy(); }, 1200000);
    res.once('close', () => { abort.abort(); clearTimeout(deadline); });
    try {
      if (req.method === 'HEAD' && path === '/') { res.writeHead(200); res.end(); return; }
      if (req.method === 'GET') {
        if (path === '/api/tags') { json(res, 200, { ...cache.tags, models: [...cache.tags.models.filter(m => !ALIASES.has(m.name)), info] }); return; }
        if (path === '/v1/models') { json(res, 200, { ...cache.models, data: [...cache.models.data.filter(m => !ALIASES.has(m.id)), { id: MODEL, object: 'model', owned_by: 'local', context_length: CAPACITY.contextWindow, backend: 'Gufo (Ollama-compatible)' }] }); return; }
        if (path === '/api/version') { json(res, 200, cache.version); return; }
        if (path === '/health') { json(res, 200, { status: 'gateway_alive', backend: current, active: queue.running, queued: queue.jobs.length }); return; }
        if (path === '/') { res.end('Ollama-compatible local model gateway is running'); return; }
        if (path === '/api/ps') {
          json(res, 200, current === 'gufo' ? { models: [{ ...info, expires_at: new Date(Date.now() + idleMs).toISOString(), context_length: CAPACITY.contextWindow, size_vram: 0 }] } : await query(ollamaURL, path)); return;
        }
        fail(res, 404, 'Endpoint not exposed'); return;
      }
      if (req.method !== 'POST' && !(req.method === 'DELETE' && path === '/api/delete')) { fail(res, 405, 'Method not supported'); req.resume(); return; }
      const body = await readBody(req);
      let payload; try { payload = JSON.parse(body.toString() || '{}'); } catch { throw bad('Invalid JSON'); }
      requestedModel = String(payload.model || payload.name || '').slice(0, 120);
      if (abort.signal.aborted) return;
      const agron = ALIASES.has(payload.model || payload.name);
      if (path === '/api/show') {
        if (agron) json(res, 200, { modelfile: '# Local Gufo backend exposed through the Ollama-compatible gateway\nFROM huiwen-2-agron:latest\nSYSTEM ' + JSON.stringify(SYSTEM), template: '', system: SYSTEM, parameters: `num_ctx ${CAPACITY.contextWindow}\nnum_predict ${CAPACITY.defaultMaxTokens}`, details, model_info: { 'general.name': BRAND, 'general.type': 'model', 'huiwen.context_length': CAPACITY.contextWindow }, capabilities: ['completion', 'tools'], backend: 'Gufo', compatibility_entry: true });
        else {
          const name = payload.model || payload.name;
          if (current === 'gufo') {
            if (cache.shows.has(name)) json(res, 200, cache.shows.get(name));
            else fail(res, 503, 'Ollama metadata temporarily unavailable while Agron owns resources');
          } else { const value = await query(ollamaURL, path, payload); cache.shows.set(name, value); json(res, 200, value); }
        }
        return;
      }
      if (MANAGE.has(path)) {
        if (agron || ALIASES.has(payload.destination) || ALIASES.has(payload.source)) { fail(res, 405, 'Agron is a compatibility entry, not a native Ollama manifest; use /api/generate keep_alive:0 to unload'); return; }
        await queue.run(async () => {
          await switchTo('ollama');
          if (!abort.signal.aborted) await proxy(req, res, body, ollamaURL);
          cache.tags = await query(ollamaURL, '/api/tags'); cache.models = await query(ollamaURL, '/v1/models');
        }, abort.signal); return;
      }
      if (path === '/internal/warmup') {
        if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) { fail(res, 403, 'Loopback warmup only'); return; }
        if (payload.model !== 'huiwen-luna:latest') throw bad('Unsupported warmup model');
        if (queue.running || queue.jobs.length) { json(res, 200, { skipped: true, reason: 'foreground_or_switch_active' }); return; }
        await queue.run(async () => {
          await switchTo('ollama');
          await query(ollamaURL, '/api/generate', { model: payload.model, prompt: '', stream: false, keep_alive: 300 }, 900000).catch(backoff);
          failures = 0;
          json(res, 200, { warmed: true, model: payload.model });
        }, abort.signal, { priority: 'warmup' });
        return;
      }
      if (!INFER.has(path)) { fail(res, 404, 'Endpoint not exposed'); return; }
      if (agron && ['/api/embed', '/api/embeddings'].includes(path)) throw bad('Agron is not an embedding model');
      // An empty /api/generate is Ollama CLI's load/unload probe, not a prompt.
      const probe = agron && ['/api/generate', '/api/chat'].includes(path) && !payload.prompt && !payload.messages?.length && !payload.tools?.length;
      // Validate options even for empty CLI load/unload probes.
      const converted = agron ? convert(probe && path === '/api/chat' ? { ...payload, messages: payload.messages || [] } : payload, path) : null;
      clearTimeout(idle);
      observe('queued');
      await queue.run(async () => {
        observe('admitted');
        if (abort.signal.aborted) return;
        if (probe && payload.keep_alive === 0) {
          await switchTo('ollama');
          json(res, 200, { model: MODEL, created_at: new Date().toISOString(), ...(path === '/api/chat' ? { message: { role: 'assistant', content: '' } } : { response: '' }), done: true, done_reason: 'unload' }); return;
        }
        await switchTo(agron ? 'gufo' : 'ollama');
        observe('backend_ready');
        if (abort.signal.aborted) { armIdle(); return; }
        if (probe) json(res, 200, { model: MODEL, created_at: new Date().toISOString(), ...(path === '/api/chat' ? { message: { role: 'assistant', content: '' } } : { response: '' }), done: true, done_reason: 'load' });
        else if (agron) await forwardAgron(res, converted, path, gufoURL, key).catch(backoff);
        else await proxy(req, res, body, ollamaURL).catch(backoff);
        failures = 0;
        armIdle();
        observe(abort.signal.aborted ? 'drained_after_disconnect' : 'settled');
      }, abort.signal);
    } catch (e) { if (res.headersSent) { if (!res.destroyed) res.destroy(); } else fail(res, e.status || 503, e.status ? e.message : 'Local model operation failed; check gateway journal'); console.error('[agron]', e.message); armIdle(); }
    finally { clearTimeout(deadline); }
  };
  const server = http.createServer(handler);
  server.headersTimeout = 30000; server.requestTimeout = 1250000; server.keepAliveTimeout = 1000; server.maxConnections = 128;
  return { server, queue, recover: () => queue.run(() => switchTo('ollama')), close: () => { clearTimeout(idle); server.close(); } };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = JSON.parse(readFileSync('/etc/dsh-huiwen-agron.json', 'utf8'));
  const idleMs = idleDelay(config);
  const execute = promisify(execFile);
  const activate = async target => { const { stdout } = await execute('/usr/bin/python3', ['/usr/local/lib/dsh-huiwen-agron/controller.py', target], { maxBuffer: 1048576 }); console.error('[agron] resource switch', stdout.trim()); };
  await activate('ollama');
  const gateway = await createGateway({ ollamaURL: 'http://127.0.0.1:11439', gufoURL: 'http://127.0.0.1:18092', key: readFileSync(config.key_file, 'utf8').trim(), activate, idleMs, receipt: JSON.parse(readFileSync(config.weight_receipt, 'utf8')) });
  gateway.server.listen(18100, '127.0.0.1');
  let stopping = false;
  const stop = async () => { if (stopping) return; stopping = true; gateway.queue.closed = true; gateway.close(); const poll = setInterval(async () => { if (gateway.queue.running) return; clearInterval(poll); try { await activate('ollama'); process.exit(0); } catch (e) { console.error(e.message); process.exit(1); } }, 200); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}
