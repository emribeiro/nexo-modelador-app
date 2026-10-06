import { z } from 'zod';
const name = z.string().trim().min(1, 'Informe um nome.').max(160);
const object = z.record(z.unknown());
const id = z.string().max(200);
const meta = { id: id.optional(), revision: z.number().int().optional() };
const base = { ...meta, name, description: z.string().max(10000).default('') };
export const operationSchema = z.object({
  id: z.string().min(1).max(160), name,
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  path: z.string().startsWith('/').max(2000),
  description: z.string().default(''), parameters: z.array(object).default([]),
  headers: object.default({}), requestBody: z.unknown().optional(), responses: object.default({}),
  security: z.array(object).optional(),
});
const node = z.object({
  id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/, 'Use letras, números, _ ou - no identificador da etapa.'),
  position: z.object({ x: z.number(), y: z.number() }), type: z.string().optional(),
  data: z.object({ label: name, serviceId: id, operationId: id, authId: id.default(''),
    input: object.default({}), timeout: z.number().int().min(100).max(60000).default(10000),
    onError: z.enum(['stop', 'continue']).default('stop'),
    condition: z.object({ path: z.string(), operator: z.enum(['equals','notEquals','exists','gt','lt']), value: z.unknown().optional() }).nullable().optional(),
  }),
});
export const schemas = {
  systems: z.object({ ...base, owner: z.string().default('') }),
  channels: z.object({ ...base, type: z.enum(['digital','physical']).default('digital') }),
  services: z.object({ ...base, version: z.string().min(1).default('1.0.0'), systemId: id.default(''), channelIds: z.array(id).default([]),
    environments: z.record(z.string().max(2000)).default({}), authId: id.default(''),
    operations: z.array(operationSchema).max(500), schemas: object.default({}), securitySchemes: object.default({}),
    source: object.optional(), contract: object.optional(),
  }),
  auth: z.object({ ...meta, name, type: z.enum(['bearer','oauth2','custom']), environments: z.record(z.object({
    token: z.string().max(16000).default(''), tokenUrl: z.string().max(2000).default(''),
    clientId: z.string().max(2000).default(''), clientSecret: z.string().max(16000).default(''),
    scope: z.string().max(2000).default(''), clientAuth: z.enum(['body','basic']).default('body'),
    headers: object.default({}), body: object.default({}),
    tokenPath: z.string().default('access_token'), expiresPath: z.string().default('expires_in'),
  })) }),
  flows: z.object({ ...base, systemId: id.default(''), channelIds: z.array(id).default([]), input: object.default({}),
    nodes: z.array(node).min(1).max(50), edges: z.array(z.object({ id, source: id, target: id })).max(50),
  }),
  tests: z.object({ ...base, targetType: z.enum(['operation','flow']), serviceId: id.default(''), operationId: id.default(''), flowId: id.default(''),
    environment: z.string().min(1).default('desenvolvimento'), input: object.default({}),
    scenario: z.enum(['positive','negative']).default('positive'),
    assertions: z.array(z.object({ path: z.string().min(1), operator: z.enum(['equals','notEquals','exists','type','schema','contains','gt','lt']), expected: z.unknown().optional() })).min(1).max(100),
  }),
};
export function assert(condition, message, status = 400) { if (!condition) throw Object.assign(new Error(message), { status }); }
export function validateRelations(store, kind, doc) {
  if (doc.systemId) assert(store.get('systems', doc.systemId), 'Sistema não encontrado.');
  for (const channel of doc.channelIds || []) assert(store.get('channels', channel), 'Canal não encontrado.');
  if (doc.authId) assert(store.get('auth', doc.authId), 'Perfil de autenticação não encontrado.');
  if (kind === 'auth') {
    assert(Object.keys(doc.environments).length > 0, 'Configure pelo menos um ambiente de autenticação.');
    for (const [env, config] of Object.entries(doc.environments)) {
      if (doc.type === 'bearer') assert(config.token, `Informe o bearer token para ${env}.`);
      else {
        let url; try { url = new URL(config.tokenUrl); } catch { /* Report a validation message below. */ }
        assert(url && ['http:','https:'].includes(url.protocol) && !url.username && !url.password, `Informe uma URL de token válida para ${env}.`);
        if (doc.type === 'oauth2') assert(config.clientId && config.clientSecret, `Informe Client ID e Client secret para ${env}.`);
        assert(config.tokenPath, `Informe o caminho do access_token para ${env}.`);
      }
    }
  }
  if (kind === 'services') assert(new Set(doc.operations.map(o => o.id)).size === doc.operations.length, 'Identificadores de operações devem ser únicos.');
  if (kind === 'flows') {
    assert(new Set(doc.nodes.map(n => n.id)).size === doc.nodes.length, 'Identificadores de etapas devem ser únicos.');
    const ids = new Set(doc.nodes.map(n => n.id));
    for (const edge of doc.edges) assert(ids.has(edge.source) && ids.has(edge.target) && edge.source !== edge.target, 'Conexão inválida.');
    for (const n of doc.nodes) {
      assert(store.get('services', n.data.serviceId)?.operations.some(o => o.id === n.data.operationId), `Operação inválida na etapa ${n.data.label}.`);
      if (n.data.authId) assert(store.get('auth', n.data.authId), 'Perfil de autenticação não encontrado.');
    }
    orderFlow(doc);
  }
  if (kind === 'tests') {
    if (doc.targetType === 'flow') assert(store.get('flows', doc.flowId), 'Fluxo não encontrado.');
    else assert(store.get('services', doc.serviceId)?.operations.some(o => o.id === doc.operationId), 'Operação não encontrada.');
  }
}
export function orderFlow(flow) {
  const incoming = new Map(flow.nodes.map(n => [n.id, 0]));
  const outgoing = new Map();
  for (const e of flow.edges) { incoming.set(e.target, (incoming.get(e.target) || 0) + 1); outgoing.set(e.source, [...(outgoing.get(e.source) || []), e.target]); }
  assert([...incoming.values()].every(c => c <= 1) && [...outgoing.values()].every(v => v.length <= 1), 'Nesta versão, conecte as etapas em uma única sequência; use condições nas etapas.');
  const roots = flow.nodes.filter(n => !incoming.get(n.id));
  assert(roots.length === 1, 'O fluxo precisa de um único início e de todas as etapas conectadas.');
  const ordered = []; let current = roots[0]; const visited = new Set();
  while (current) { assert(!visited.has(current.id), 'O fluxo não pode conter ciclos.'); visited.add(current.id); ordered.push(current); current = flow.nodes.find(n => n.id === outgoing.get(current.id)?.[0]); }
  assert(ordered.length === flow.nodes.length, 'Conecte todas as etapas em uma sequência sem ciclos.');
  return ordered;
}
