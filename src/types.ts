export type RecordData = { id: string; name: string; description?: string; revision?: number; createdAt?: string; updatedAt?: string; [key: string]: any };
export type User = { id: string; name: string; email: string; role: 'admin' | 'editor' | 'viewer' };
export type Workspace = { systems: RecordData[]; channels: RecordData[]; services: RecordData[]; auth: RecordData[]; flows: RecordData[]; tests: RecordData[]; runs: RecordData[]; audit: any[]; settings: { allowedOrigins: string[]; sensitiveFields: string[] }; user: User };
export type Page = 'overview' | 'services' | 'flows' | 'tests' | 'imports' | 'auth' | 'topology' | 'history' | 'settings';
