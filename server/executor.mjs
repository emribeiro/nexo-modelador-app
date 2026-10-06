import Ajv from 'ajv';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { isDeepStrictEqual } from 'node:util';
import { assert, orderFlow } from './models.mjs';
import { redact, secretKeys } from './store.mjs';
const ajv = new Ajv({ strict: false, allErrors: true, validateFormats: true });
const ajv2020 = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv); addFormats(ajv2020);
const dangerousKeys = new Set(['__proto__', 'constructor', 'prototype']);
export function getPath(object, path) {
  if (!path || path === '$') return object;
  const parts = path.replace(/^\$\.?/, '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let value = object;
  for (const part of parts) {
    if (dangerousKeys.has(part) || value == null || !Object.hasOwn(Object(value), part)) return undefined;
    value = value[part];
  }
  return value;
}
export function interpolate(value, context) {
  if (Array.isArray(value)) return value.map(v => interpolate(v, context));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k]) => !dangerousKeys.has(k)).map(([k, v]) => [k, interpolate(v, context)]));
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{\{\s*([^{}]+?)\s*\}\}$/);
  const read = path => { const result = getPath(context, path.trim()); assert(result !== undefined, `Variável não encontrada: ${path.trim()}`); return result; };
  if (exact) return read(exact[1]);
  return value.replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_, path) => String(read(path)));
}
export function allowedUrl(store, input) {
  let url; try { url = new URL(input); } catch { throw Object.assign(new Error('Informe uma URL absoluta válida.'), { status: 400 }); }
  assert(['http:', 'https:'].includes(url.protocol), 'Somente URLs HTTP ou HTTPS são permitidas.');
  assert(!url.username && !url.password, 'Credenciais não podem ser incluídas na URL.');
  assert(store.settings().allowedOrigins.includes(url.origin), `Destino não autorizado: ${url.origin}. Um administrador deve cadastrá-lo em Configurações.`, 403);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  assert(url.protocol === 'https:' || local, 'Use HTTPS para destinos que não sejam locais.');
  return url;
}
export async function boundedFetch(store, url, init = {}, timeout = 10000) {
  const target = allowedUrl(store, url);
  const signal = AbortSignal.timeout(Math.min(Math.max(timeout, 100), 60000));
  const response = await fetch(target, { ...init, redirect: 'manual', signal });
  assert(response.status < 300 || response.status >= 400, 'Redirecionamento recusado. Cadastre e utilize a URL final autorizada.');
  assert(Number(response.headers.get('content-length') || 0) <= 2_000_000, 'Resposta excede o limite de 2 MB.');
  const reader = response.body?.getReader(); const chunks = []; let length = 0;
  if (reader) {
    try { while (true) { const { done, value } = await reader.read(); if (done) break; length += value.length; assert(length <= 2_000_000, 'Resposta excede o limite de 2 MB.'); chunks.push(value); } }
    catch (error) { await reader.cancel(); throw error; }
  }
  const text = Buffer.concat(chunks).toString('utf8'); let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: response.status, headers: Object.fromEntries(response.headers), body, text };
}
function schemaResult(value, schema, use2020 = false) {
  try {
    const engine = use2020 || schema?.$schema?.includes('2020-12') ? ajv2020 : ajv;
    const validate = engine.compile(schema); const valid = validate(value);
    return { valid, message: valid ? '' : engine.errorsText(validate.errors, { separator: '; ' }) };
  } catch (error) { return { valid: false, message: `Schema inválido ou não suportado: ${error.message}` }; }
}
export function compare(actual, operator, expected) {
  switch (operator) {
    case 'equals': return { valid: isDeepStrictEqual(actual, expected) };
    case 'notEquals': return { valid: !isDeepStrictEqual(actual, expected) };
    case 'exists': return { valid: expected === false ? actual === undefined : actual !== undefined };
    case 'type': return { valid: (actual === null ? 'null' : Array.isArray(actual) ? 'array' : typeof actual) === expected };
    case 'contains': return { valid: typeof actual === 'string' ? actual.includes(String(expected)) : Array.isArray(actual) && actual.some(v => isDeepStrictEqual(v, expected)) };
    case 'gt': return { valid: typeof actual === 'number' && typeof expected === 'number' && actual > expected };
    case 'lt': return { valid: typeof actual === 'number' && typeof expected === 'number' && actual < expected };
    case 'schema': return schemaResult(actual, expected);
    default: return { valid: false, message: 'Comparador desconhecido.' };
  }
}
export function createExecutor(store) {
  const tokenCache = new Map();
  async function tokenFor(profileId, environment, secrets) {
    if (!profileId) return '';
    const profile = store.get('auth', profileId); assert(profile, 'Perfil de autenticação não encontrado.');
    const config = profile.environments[environment]; assert(config, `Autenticação sem configuração para ${environment}.`);
    secrets.push(config.token, config.clientSecret, ...Object.values(config.headers || {}).filter(v => typeof v === 'string'));
    function collect(value) { if (typeof value === 'string' && value.length > 2) secrets.push(value); else if (value && typeof value === 'object') Object.values(value).forEach(collect); }
    collect(config.body);
    if (profile.type === 'bearer') { assert(config.token, 'Informe o bearer token neste ambiente.'); return config.token; }
    const key = `${profileId}:${profile.revision}:${environment}`; const cached = tokenCache.get(key);
    if (cached && cached.expiresAt > Date.now() + 5000) { secrets.push(cached.token); return cached.token; }
    let headers = { 'Content-Type': 'application/json', ...config.headers }; let body = JSON.stringify(config.body);
    if (profile.type === 'oauth2') {
      const form = { grant_type: 'client_credentials', scope: config.scope || '' };
      headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
      if (config.clientAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(config.clientSecret)}`).toString('base64')}`;
      else Object.assign(form, { client_id: config.clientId, client_secret: config.clientSecret });
      body = new URLSearchParams(form).toString();
    }
    const result = await boundedFetch(store, config.tokenUrl, { method: 'POST', headers, body });
    assert(result.status >= 200 && result.status < 300, `Autenticação recusada pelo provedor (HTTP ${result.status}).`);
    const token = getPath(result.body, config.tokenPath || 'access_token');
    assert(typeof token === 'string' && token.length > 0, 'O endpoint de autenticação não retornou um token no caminho configurado.');
    secrets.push(token);
    const expiresIn = Number(getPath(result.body, config.expiresPath || 'expires_in'));
    if (Number.isFinite(expiresIn) && expiresIn > 0) tokenCache.set(key, { token, expiresAt: Date.now() + Math.min(expiresIn, 86400) * 1000 });
    return token;
  }
  async function operation({ serviceId, operationId, environment = 'desenvolvimento', input = {}, authId, timeout = 10000, validateInput = true }, secrets = []) {
    const service = store.get('services', serviceId); assert(service, 'Serviço não encontrado.', 404);
    const op = service.operations.find(o => o.id === operationId); assert(op, 'Operação não encontrada.', 404);
    const base = service.environments[environment]; assert(base, `Configure a URL base do serviço para ${environment}.`);
    let path = op.path;
    for (const match of path.matchAll(/\{([^{}]+)\}/g)) {
      const v = input.path?.[match[1]]; assert(v !== undefined, `Parâmetro de caminho obrigatório: ${match[1]}.`);
      path = path.replace(match[0], encodeURIComponent(String(v)));
    }
    assert(!path.includes('?') && !path.includes('#'), 'O caminho deve conter somente o path; configure query parameters separadamente.');
    const url = new URL(base.replace(/\/$/, '') + path);
    for (const [k, v] of Object.entries(input.query || {})) { if (Array.isArray(v)) v.forEach(item => url.searchParams.append(k, String(item))); else if (v != null) url.searchParams.set(k, String(v)); }
    allowedUrl(store, url);
    const headers = { Accept: 'application/json', ...op.headers, ...input.headers };
    for (const key of Object.keys(headers)) assert(!/^(host|connection|content-length|transfer-encoding|cookie|proxy-authorization)$/i.test(key), `Cabeçalho não permitido: ${key}.`);
    if (validateInput) {
      for (const p of op.parameters) {
        const group = p.in === 'header' ? headers : input[p.in];
        const value = p.in === 'header' ? Object.entries(group || {}).find(([key]) => key.toLowerCase() === p.name.toLowerCase())?.[1] : group?.[p.name];
        assert(!p.required || value !== undefined, `Parâmetro obrigatório: ${p.name}.`);
        if (value !== undefined && p.schema) { const result = schemaResult(value, p.schema, service.contract?.openapi?.startsWith('3.1')); assert(result.valid, `Parâmetro ${p.name}: ${result.message}`); }
      }
      if (op.requestBody?.required) assert(input.body !== undefined, 'Corpo da requisição obrigatório.');
      const schema = op.requestBody?.content?.['application/json']?.schema;
      if (input.body !== undefined && schema !== undefined) { const result = schemaResult(input.body, schema, service.contract?.openapi?.startsWith('3.1')); assert(result.valid, `Corpo da requisição: ${result.message}`); }
    }
    const token = await tokenFor(authId === undefined || authId === '' ? service.authId : authId, environment, secrets);
    if (token) { for (const key of Object.keys(headers)) if (key.toLowerCase() === 'authorization') delete headers[key]; headers.Authorization = `Bearer ${token}`; }
    let body;
    if (input.body !== undefined && !['GET','HEAD'].includes(op.method)) {
      body = typeof input.body === 'string' ? input.body : JSON.stringify(input.body);
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    }
    const start = performance.now();
    try {
      const result = await boundedFetch(store, url.toString(), { method: op.method, headers, body }, timeout);
      return { status: result.status, headers: result.headers, body: result.body, duration: Math.round(performance.now() - start), success: result.status >= 200 && result.status < 300, request: { method: op.method, url: url.toString() } };
    } catch (error) {
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error(`Tempo limite de ${timeout} ms excedido.`);
      throw error;
    }
  }
  async function flow(flowId, environment, input, secrets = [], validateInput = true) {
    const definition = store.get('flows', flowId); assert(definition, 'Fluxo não encontrado.', 404);
    const steps = {}; const context = { input: { ...definition.input, ...input }, steps }; let success = true; let stopped = false;
    for (const node of orderFlow(definition)) {
      const d = node.data;
      if (stopped) { steps[node.id] = { skipped: true, reason: 'Execução interrompida por falha anterior.' }; continue; }
      if (d.condition && !compare(getPath(context, d.condition.path), d.condition.operator, d.condition.value).valid) {
        steps[node.id] = { skipped: true, reason: 'Condição não atendida.' }; continue;
      }
      try {
        steps[node.id] = { label: d.label, ...await operation({ ...d, environment, validateInput, input: interpolate(d.input, context) }, secrets) };
        if (!steps[node.id].success) { success = false; if (d.onError !== 'continue') stopped = true; }
      } catch (error) { steps[node.id] = { label: d.label, success: false, error: error.message }; success = false; if (d.onError !== 'continue') stopped = true; }
    }
    return { success, steps };
  }
  function sanitize(value, secrets) {
    const sensitive = key => secretKeys.test(key) || (store.settings().sensitiveFields || []).some(f => f.toLowerCase() === key.toLowerCase());
    const hiddenValues = new Set();
    function discover(v) {
      if (!v || typeof v !== 'object') return;
      for (const [key, val] of Object.entries(v)) {
        if (sensitive(key) && ['string','number'].includes(typeof val)) hiddenValues.add(val);
        else discover(val);
      }
    }
    discover(value);
    function fields(v) {
      if (hiddenValues.has(v)) return '••••••••';
      if (typeof v === 'string' && /^https?:\/\//.test(v)) {
        try { const url = new URL(v); let changed = false; for (const key of url.searchParams.keys()) if (sensitive(key)) { url.searchParams.set(key,'••••••••'); changed = true; } if (changed) return url.toString(); } catch { /* Not an absolute URL. */ }
      }
      if (Array.isArray(v)) return v.map(fields);
      if (v && typeof v === 'object') {
        const assertionSensitive = typeof v.path === 'string' && sensitive(v.path.split('.').pop());
        return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, sensitive(k) || (assertionSensitive && ['expected','actual'].includes(k)) ? '••••••••' : fields(val)]));
      }
      return v;
    }
    return redact(fields(value), [...secrets, ...hiddenValues].filter(v => typeof v === 'string'));
  }
  async function execute(type, args, actor) {
    const startedAt = new Date().toISOString(); const start = performance.now(); const secrets = [];
    let result; let name = ''; let targetId = '';
    try {
      if (type === 'test') {
        const test = store.get('tests', args.testId); assert(test, 'Teste não encontrado.', 404); name = test.name; targetId = test.id;
        const output = test.targetType === 'flow' ? await flow(test.flowId, test.environment, test.input, secrets, test.scenario !== 'negative') : await operation({ ...test, validateInput: test.scenario !== 'negative' }, secrets);
        const assertions = test.assertions.map(a => {
          const actual = getPath(output, a.path); const comparison = compare(actual, a.operator, a.expected);
          return { ...a, actual: actual === undefined ? '(ausente)' : actual, passed: comparison.valid, message: comparison.valid ? 'Validação atendida.' : comparison.message || `A validação ${a.operator} não foi atendida em ${a.path}.` };
        });
        result = { success: assertions.every(a => a.passed), output, assertions };
      } else if (type === 'flow') {
        const def = store.get('flows', args.flowId); name = def?.name || 'Fluxo'; targetId = args.flowId;
        result = await flow(args.flowId, args.environment, args.input, secrets);
      } else { const s = store.get('services', args.serviceId); name = s?.operations.find(o => o.id === args.operationId)?.name || 'Operação'; targetId = args.serviceId; result = await operation(args, secrets); }
    } catch (error) { result = { success: false, error: error.message }; }
    const run = store.save('runs', sanitize({ name, type, targetId, environment: args.environment || (type === 'test' ? store.get('tests', args.testId)?.environment : 'desenvolvimento'), startedAt, duration: Math.round(performance.now() - start), actor, result }, secrets));
    store.audit(actor, 'Executou ' + type, name || targetId || type);
    return run;
  }
  return { execute, operation, flow, tokenFor, sanitize };
}
