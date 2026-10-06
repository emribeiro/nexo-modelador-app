import YAML from 'yaml';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assert, schemas } from './models.mjs';
import { allowedUrl } from './executor.mjs';
const exec = promisify(execFile);
const methods = ['get','post','put','patch','delete','head','options'];
const clean = value => JSON.parse(JSON.stringify(value));

export function importContract(content, source = {}) {
  assert(typeof content === 'string' && content.length <= 2_000_000, 'O contrato deve ter até 2 MB.');
  let doc;
  try { doc = YAML.parse(content, { maxAliasCount: 30, uniqueKeys: true }); }
  catch (error) { throw new Error(`Documento JSON/YAML inválido: ${error.message}`); }
  assert(doc && typeof doc === 'object' && !Array.isArray(doc), 'O documento deve ser um objeto OpenAPI.');
  const v2 = doc.swagger === '2.0';
  assert(v2 || /^3\.(0|1)\.\d+$/.test(doc.openapi || ''), 'Versão não suportada. Use Swagger 2.0, OpenAPI 3.0 ou 3.1.');
  assert(doc.info && typeof doc.info.title === 'string' && typeof doc.info.version === 'string', 'O contrato deve conter info.title e info.version.');
  assert(doc.paths && typeof doc.paths === 'object' && !Array.isArray(doc.paths), 'O contrato deve conter paths.');
  const warnings = new Set();
  function resolve(value, chain = [], depth = 0) {
    assert(depth < 80, 'O contrato excede a profundidade permitida.');
    if (Array.isArray(value)) return value.map(v => resolve(v, chain, depth + 1));
    if (!value || typeof value !== 'object') return value;
    if (value.$ref) {
      assert(value.$ref.startsWith('#/'), `Referência externa não suportada: ${value.$ref}. Envie um contrato com referências locais.`);
      if (chain.includes(value.$ref)) { warnings.add(`Schema recursivo ${value.$ref}: expansão interrompida; revise a validação dos campos recursivos.`); return {}; }
      const path = value.$ref.slice(2).split('/').map(v => v.replace(/~1/g, '/').replace(/~0/g, '~'));
      assert(!path.some(p => ['__proto__', 'constructor', 'prototype'].includes(p)), 'Referência inválida.');
      let resolved = doc; for (const key of path) resolved = resolved?.[key];
      assert(resolved !== undefined, `Referência não encontrada: ${value.$ref}`);
      return { ...resolve(resolved, [...chain, value.$ref], depth + 1), ...resolve(Object.fromEntries(Object.entries(value).filter(([k]) => k !== '$ref')), chain, depth + 1) };
    }
    return Object.fromEntries(Object.entries(value).filter(([k]) => !['__proto__','constructor','prototype'].includes(k)).map(([k,v]) => [k, resolve(v, chain, depth + 1)]));
  }
  const operations = []; const ids = new Set();
  for (const [path, raw] of Object.entries(doc.paths)) {
    if (path.startsWith('x-')) continue;
    assert(path.startsWith('/') && raw && typeof raw === 'object', `Caminho inválido: ${path}.`);
    const item = resolve(raw);
    for (const method of methods) {
      const operation = item[method]; if (!operation) continue;
      assert(operation.responses && Object.keys(operation.responses).length, `${method.toUpperCase()} ${path}: informe responses.`);
      let id = operation.operationId || `${method}_${path.replace(/[^a-zA-Z0-9]/g, '_')}`;
      if (ids.has(id)) { warnings.add(`operationId duplicado: ${id}; um identificador exclusivo foi atribuído.`); id += '_' + operations.length; }
      ids.add(id);
      const merged = new Map();
      for (const p of [...(item.parameters || []), ...(operation.parameters || [])]) {
        assert(p.name && p.in, `Parâmetro inválido em ${method.toUpperCase()} ${path}.`);
        if (p.in === 'path') assert(p.required === true, `O parâmetro de caminho ${p.name} deve ser obrigatório.`);
        merged.set(`${p.in}:${p.name}`, p);
      }
      const parameters = [...merged.values()]; let requestBody = operation.requestBody;
      if (parameters.some(p => p.in === 'cookie')) warnings.add('Parâmetros em cookies foram preservados no contrato, mas não são enviados pelo executor inicial.');
      if (parameters.some(p => p.style && !['simple','form'].includes(p.style) || p.schema?.type === 'object')) warnings.add('Há serialização complexa de parâmetros. O executor inicial suporta valores simples e arrays em query; revise a requisição antes de executar.');
      if (v2) {
        const body = parameters.find(p => p.in === 'body');
        if (body) requestBody = { required: !!body.required, content: { 'application/json': { schema: body.schema || {} } } };
        if (parameters.some(p => p.in === 'formData')) warnings.add('Parâmetros formData foram preservados no contrato; a execução inicial usa corpos JSON ou texto.');
      }
      if (requestBody?.content && !requestBody.content['application/json']) warnings.add(`${method.toUpperCase()} ${path}: corpo não JSON; configure Content-Type e o corpo textual manualmente.`);
      if (operation.callbacks) warnings.add('Callbacks foram preservados no contrato, mas não são executados.');
      if (operation.security?.length || doc.security?.length) warnings.add('Esquemas de segurança importados. Associe um perfil com credenciais antes de executar.');
      const responses = v2 ? Object.fromEntries(Object.entries(operation.responses).map(([k,v]) => [k, { ...v, ...(v.schema ? { content: { 'application/json': { schema: v.schema } } } : {}) }])) : operation.responses;
      operations.push({ id, name: operation.summary || operation.operationId || `${method.toUpperCase()} ${path}`, method: method.toUpperCase(), path,
        description: operation.description || '', parameters: parameters.filter(p => p.in !== 'body').map(p => ({ ...p, schema: p.schema || Object.fromEntries(Object.entries(p).filter(([k]) => ['type','format','enum','items','minimum','maximum','pattern','default'].includes(k))) })),
        headers: {}, requestBody, responses, security: operation.security || doc.security || [],
      });
    }
  }
  assert(operations.length > 0, 'Nenhuma operação HTTP reconhecida no contrato.');
  let base = v2 ? (doc.host ? `${doc.schemes?.[0] || 'https'}://${doc.host}${doc.basePath || ''}` : '') : doc.servers?.[0]?.url || '';
  if (doc.servers?.[0]?.variables) for (const [key, variable] of Object.entries(doc.servers[0].variables)) base = base.replaceAll(`{${key}}`, String(variable.default ?? `{${key}}`));
  if (base && !/^https?:\/\//.test(base)) { warnings.add('URL base relativa: informe uma URL absoluta antes da execução.'); base = ''; }
  if (doc.servers?.length > 1 || operations.some(o => doc.paths[o.path]?.[o.method.toLowerCase()]?.servers || doc.paths[o.path]?.servers)) warnings.add('Apenas o primeiro servidor global foi usado. Revise URLs por ambiente e servidores específicos de operações.');
  if (doc.webhooks) warnings.add('Webhooks foram preservados no contrato, mas não são executados.');
  const securitySchemes = resolve(v2 ? doc.securityDefinitions || {} : doc.components?.securitySchemes || {});
  for (const scheme of Object.values(securitySchemes)) if (!['oauth2','http'].includes(scheme.type) || (scheme.type === 'http' && scheme.scheme !== 'bearer')) warnings.add('Há um esquema de segurança sem perfil dedicado nesta versão; revise os cabeçalhos necessários.');
  const service = schemas.services.parse({ name: doc.info.title, version: doc.info.version, description: doc.info.description || '', environments: { desenvolvimento: base, homologacao: '' }, operations,
    schemas: resolve(v2 ? doc.definitions || {} : doc.components?.schemas || {}), securitySchemes, contract: clean(doc), source: { ...source, format: v2 ? 'Swagger 2.0' : `OpenAPI ${doc.openapi}` },
  });
  return { service, warnings: [...warnings] };
}
export function diffService(existing, incoming) {
  if (!existing) return { added: incoming.operations.map(o => `${o.method} ${o.path}`), removed: [], changed: [], metadata: [], conflicts: [] };
  const key = o => `${o.method} ${o.path}`; const old = new Map(existing.operations.map(o => [key(o), o])); const next = new Map(incoming.operations.map(o => [key(o), o]));
  const added = [...next.keys()].filter(k => !old.has(k)); const removed = [...old.keys()].filter(k => !next.has(k));
  const changed = [...next.keys()].filter(k => old.has(k) && JSON.stringify(old.get(k)) !== JSON.stringify(next.get(k)));
  const metadata = ['name','version','description','schemas','securitySchemes'].filter(k => JSON.stringify(existing[k]) !== JSON.stringify(incoming[k]));
  return { added, removed, changed, metadata, conflicts: [...removed.map(k => `A operação ${k} será removida.`), ...changed.map(k => `A definição local de ${k} será substituída.`)] };
}
function javaType(type, dtos = new Set()) {
  const t = type.trim().replace(/\b(final|volatile|transient)\b/g, '').trim();
  const list = t.match(/^(?:List|Set|Collection)<(.+)>$/) || t.match(/^(.+)\[\]$/);
  if (list) return { type: 'array', items: javaType(list[1], dtos) };
  if (/^(int|Integer|long|Long|short|Short|BigInteger)$/.test(t)) return { type: 'integer' };
  if (/^(double|Double|float|Float|BigDecimal)$/.test(t)) return { type: 'number' };
  if (/^(boolean|Boolean)$/.test(t)) return { type: 'boolean' };
  if (/^(String|UUID|LocalDate|LocalDateTime|Instant|char|Character)$/.test(t)) return { type: 'string', ...(t === 'UUID' ? { format: 'uuid' } : t === 'LocalDate' ? { format: 'date' } : {}) };
  if (dtos.has(t)) return { $ref: `#/components/schemas/${t}` };
  return { type: 'object', description: `Tipo Java não expandido: ${t}` };
}
export function analyzeJava(files, name = 'Projeto Quarkus') {
  const warnings = ['Análise estática parcial: revise endpoints, DTOs, respostas e obrigatoriedade. Não são inferidas regras de negócio, autenticação em runtime, herança, tipos genéricos complexos ou rotas programáticas.'];
  const dtos = new Set();
  for (const file of files) for (const m of file.content.matchAll(/\b(?:class|record)\s+(\w+)/g)) dtos.add(m[1]);
  const components = {}; const paths = {};
  for (const file of files) {
    const code = file.content.replace(/\/\*[\s\S]*?\*\//g, '');
    const classMatch = /\b(?:class|record)\s+(\w+)/.exec(code); if (!classMatch) continue;
    const properties = {}; const required = [];
    const fields = [...code.matchAll(/((?:@[\w.]+(?:\([^;]*?\))?\s*)*)(?:private|public|protected)\s+(?!static\b)([\w<>\[\], ?]+?)\s+(\w+)\s*(?:=[^;]*)?;/g)];
    for (const [, annotations, type, field] of fields) { properties[field] = javaType(type, dtos); if (/@(NotNull|NotBlank|NotEmpty)\b/.test(annotations)) required.push(field); const min = annotations.match(/@Min\((\d+)\)/); const max = annotations.match(/@Max\((\d+)\)/); if (min) properties[field].minimum = Number(min[1]); if (max) properties[field].maximum = Number(max[1]); }
    const record = code.match(/\brecord\s+\w+\s*\(([^)]*)\)/);
    if (record) for (const field of record[1].split(',')) { const m = field.trim().match(/([\w<>\[\]]+)\s+(\w+)$/); if (m) properties[m[2]] = javaType(m[1], dtos); }
    if (Object.keys(properties).length) components[classMatch[1]] = { type: 'object', properties, ...(required.length ? { required } : {}) };
    const prefix = code.slice(0, classMatch.index).match(/@Path\(\s*"([^"]*)"\s*\)/)?.[1];
    if (prefix === undefined) continue;
    const methodPattern = /@(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b([\s\S]*?)\bpublic\s+([\w<>, ?\[\].]+?)\s+(\w+)\s*\(((?:[^()]|\([^()]*\))*)\)\s*\{/g;
    for (const m of code.matchAll(methodPattern)) {
      const [, verb, annotations, returnType, method, args] = m;
      const before = code.slice(Math.max(code.lastIndexOf('}', m.index), code.lastIndexOf(';', m.index), code.indexOf('{', classMatch.index)) + 1, m.index);
      const fullAnnotations = before + annotations;
      const suffix = fullAnnotations.match(/@Path\(\s*"([^"]*)"\s*\)/)?.[1] || '';
      const path = ('/' + prefix + '/' + suffix).replace(/\/+/g, '/').replace(/\/$/, '') || '/';
      const parameters = []; let body;
      for (const arg of args.split(/,(?![^<]*>)/)) {
        const param = arg.trim().match(/@(PathParam|QueryParam|HeaderParam)\(\s*"([^"]+)"\s*\)\s*([\w<>\[\]]+)\s+\w+/);
        if (param) parameters.push({ in: { PathParam: 'path', QueryParam: 'query', HeaderParam: 'header' }[param[1]], name: param[2], required: param[1] === 'PathParam', schema: javaType(param[3], dtos) });
        else if (arg.trim() && !/@(Context|BeanParam|CookieParam|FormParam|MatrixParam)/.test(arg)) { const normalized = arg.replace(/@(?:Valid|NotNull|NotBlank)\b/g,'').trim(); if (normalized.includes('@')) continue; const match = normalized.match(/([\w<>\[\]]+)\s+\w+$/); if (match && !['GET','HEAD'].includes(verb)) body = { required: /@NotNull/.test(arg), content: { 'application/json': { schema: javaType(match[1], dtos) } } }; }
      }
      paths[path] ||= {};
      if (paths[path][verb.toLowerCase()]) warnings.push(`Rota duplicada ${verb} ${path}; revise ${file.path}.`);
      paths[path][verb.toLowerCase()] = { operationId: `${classMatch[1]}_${method}`, summary: method,
        description: `Origem: ${file.path}. Assinatura: ${returnType.trim()} ${method}. Resposta a revisar; status de runtime não inferido.`, parameters, ...(body ? { requestBody: body } : {}),
        responses: { default: { description: 'Resposta inferida da assinatura; revise o status e schema.', content: { 'application/json': { schema: javaType(returnType.trim(), dtos) } } } },
      };
    }
  }
  // Unknown DTO references are made explicit, instead of pretending to infer their fields.
  for (const dto of dtos) if (!components[dto]) components[dto] = { type: 'object', description: 'Campos não reconhecidos pela análise estática.' };
  assert(Object.keys(paths).length, 'Nenhum endpoint JAX-RS reconhecido. Exporte um contrato OpenAPI ou revise as limitações da análise estática.');
  const result = importContract(JSON.stringify({ openapi: '3.0.3', info: { title: name, version: '1.0.0' }, paths, components: { schemas: components } }), { type: 'quarkus-static', files: files.map(f => f.path) });
  return { ...result, warnings: [...warnings, ...result.warnings] };
}
export async function importGit(store, { url, ref = '', subdirectory = '', token = '', username = 'oauth2' }) {
  const target = allowedUrl(store, url); assert(target.protocol === 'https:', 'Repositórios Git devem usar HTTPS.');
  assert(!target.search && !target.hash, 'Informe a URL Git sem query ou fragmento.');
  assert(!ref.startsWith('-') && ref.length <= 200 && !/[\x00-\x20]/.test(ref), 'Branch ou tag inválida.');
  assert(!subdirectory.split('/').includes('..') && !subdirectory.startsWith('/') && !subdirectory.startsWith('-'), 'Subdiretório inválido.');
  const dir = await mkdtemp(join(tmpdir(), 'nexo-git-')); const repo = join(dir, 'repo');
  const askpass = join(dir, 'askpass.sh');
  await writeFile(askpass, '#!/bin/sh\ncase "$1" in *sername*) printf "%s" "$NEXO_GIT_USER" ;; *) printf "%s" "$NEXO_GIT_TOKEN" ;; esac\n', { mode: 0o700 });
  const env = { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || tmpdir(), GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: askpass, NEXO_GIT_USER: username, NEXO_GIT_TOKEN: token, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  const options = { env, timeout: 60000, maxBuffer: 3_000_000 };
  const config = ['-c','credential.helper=','-c','core.hooksPath=/dev/null','-c','protocol.file.allow=never','-c','http.followRedirects=false'];
  try {
    await exec('git', [...config, 'clone', '--depth=1', '--single-branch', '--no-checkout', '--filter=blob:limit=2m', ...(ref ? ['--branch', ref] : []), '--', target.toString(), repo], options);
    const { stdout: revision } = await exec('git', ['-C', repo, 'rev-parse', 'HEAD'], options);
    const { stdout: tree } = await exec('git', ['-C', repo, 'ls-tree', '-r', '--name-only', 'HEAD', '--', subdirectory || '.'], options);
    const paths = tree.split('\n').filter(Boolean); assert(paths.length <= 20000, 'Repositório muito grande. Selecione um subdiretório.');
    const contracts = paths.filter(p => /(?:^|\/)(?:openapi|swagger)\.(?:json|ya?ml)$/i.test(p));
    const files = contracts.length ? contracts.slice(0, 1) : paths.filter(p => p.endsWith('.java')).slice(0, 500);
    let total = 0; const sources = [];
    for (const path of files) { const { stdout } = await exec('git', ['-C', repo, 'show', `HEAD:${path}`], { ...options, timeout: 15000, maxBuffer: 2_000_000 }); total += stdout.length; assert(total <= 8_000_000, 'Arquivos excedem o limite de análise de 8 MB. Selecione um subdiretório.'); sources.push({ path, content: stdout }); }
    const result = contracts.length ? importContract(sources[0].content) : analyzeJava(sources, target.pathname.split('/').pop()?.replace(/\.git$/, '') || 'Projeto Quarkus');
    if (contracts.length > 1) result.warnings.push(`Foram encontrados ${contracts.length} contratos; utilizado ${contracts[0]}. Selecione um subdiretório para importar outro.`);
    if (paths.filter(p => p.endsWith('.java')).length > 500 && !contracts.length) result.warnings.push('Limite de 500 arquivos Java atingido; refine o subdiretório.');
    result.service.source = { ...result.service.source, type: contracts.length ? 'git-openapi' : 'quarkus-static', url: target.toString(), ref: ref || 'default', commit: revision.trim(), subdirectory, files: files.slice(0, 500) };
    return result;
  } catch (error) {
    if (error.cmd) throw new Error('Não foi possível ler o repositório. Verifique URL HTTPS, destino autorizado, branch/tag, permissões e limites de tamanho/tempo.');
    throw error;
  } finally { await rm(dir, { recursive: true, force: true }); }
}
