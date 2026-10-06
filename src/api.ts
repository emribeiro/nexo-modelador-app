export async function api<T = any>(path: string, data?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch('/api' + path, { credentials: 'same-origin', ...(data !== undefined ? { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Não foi possível concluir a solicitação.');
  return result;
}
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export const formatDate = (value: string) => new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export const environments = [{ value: 'desenvolvimento', label: 'Desenvolvimento' }, { value: 'homologacao', label: 'Homologação' }];
