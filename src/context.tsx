import { createContext, useContext } from 'react';
import type { Workspace, RecordData, Page } from './types';
export const AppContext = createContext<{
  data: Workspace; reload: () => Promise<void>; environment: string; setEnvironment: (value: string) => void;
  notify: (message: string, error?: boolean) => void; navigate: (page: Page, id?: string) => void;
  canEdit: boolean; save: (kind: string, doc: any) => Promise<RecordData>; remove: (kind: string, doc: RecordData) => Promise<void>;
}>(null!);
export const useApp = () => useContext(AppContext);
