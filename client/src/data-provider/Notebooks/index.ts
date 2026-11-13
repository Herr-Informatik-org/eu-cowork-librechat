import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { request } from 'librechat-data-provider';

export interface KnowledgeRoom { id: string; name: string; zone: string }
export interface KnowledgeDocument { id: string; name: string; version: string; path?:string; state: string; data_class: string; reviewed: boolean; last_error?: string | null }
export interface KnowledgeEvidence { anchor: string; documentId:string; ordinal:number; title: string; text: string; position: string; version: string; authorizedAt: string; webUrl?: string | null }
export interface KnowledgeSourceStatus { id: string; name: string; state: string; synced_at: string | null; observed_at: string | null; authorization: string }
export interface KnowledgeResult { ticket: string; evidence: KnowledgeEvidence[]; sources: KnowledgeSourceStatus[]; partial: boolean; checkedAt: string; notice: string; answer?: string }
export interface KnowledgeHistory { id: string; question?: string; answer?: string; blocked?: boolean; notice?: string }
const root = '/api/notebooks';

export function useKnowledgeStatus() {
  return useQuery(['notebooks', 'status'], () => request.get<{ available: boolean; modelZone: string; models: { name: string; label: string; zone: string }[] }>(root+'/status'), { retry: false, staleTime: 60_000 });
}
export function useKnowledgeRooms() {
  return useQuery(['notebooks', 'rooms'], () => request.get<{ rooms: KnowledgeRoom[] }>(root+'/rooms'), { retry: false, refetchOnWindowFocus: true });
}
export function useKnowledgeRoom(room: string, after = '') {
  return useQuery(['notebooks', 'documents', room,after], () => request.get<{ documents: KnowledgeDocument[]; partial:boolean; next:string|null }>(`${root}/rooms/${encodeURIComponent(room)}/documents${after ? '?after='+encodeURIComponent(after) : ''}`), { enabled: !!room, retry: false, refetchInterval: 5000 });
}
export function useKnowledgePreview(room:string,document:string,ordinal:number) {
  return useQuery(['notebooks','preview',room,document,ordinal],()=>request.get<{name:string;version:string;sections:{ordinal:number;position:string;content:string}[];next:number|null;notice:string}>(`${root}/rooms/${encodeURIComponent(room)}/documents/${encodeURIComponent(document)}/preview?ordinal=${ordinal}`),{enabled:!!room&&!!document,retry:false,refetchInterval:15000,refetchOnWindowFocus:'always',staleTime:0});
}
export function useKnowledgeSources(room:string) {
  return useQuery(['notebooks','sources',room],()=>request.get<{sources:{id:string;kind:string;state:string;connected:boolean}[]}>(`${root}/rooms/${encodeURIComponent(room)}/sources`),{enabled:!!room,retry:false});
}
export function useKnowledgeHistory(room: string) {
  return useQuery(['notebooks', 'history', room], () => request.get<{ answers: KnowledgeHistory[] }>(`${root}/rooms/${encodeURIComponent(room)}/history`), { enabled: !!room, retry: false, refetchInterval: 15_000 });
}
export function useKnowledgeAccess(room: string, ticket?: string) {
  return useQuery(['notebooks','access',room,ticket], (): Promise<{ valid:boolean }> => request.post(`${root}/rooms/${encodeURIComponent(room)}/tickets/${encodeURIComponent(ticket!)}/access`, {}), { enabled:!!room && !!ticket, retry:false, refetchInterval:15000, refetchOnWindowFocus:'always', staleTime:0 });
}
export function useKnowledgeMutations(room: string) {
  const cache = useQueryClient();
  const refresh = () => cache.invalidateQueries(['notebooks']);
  return {
    create: useMutation((data: { name: string; zone: string }): Promise<KnowledgeRoom> => request.post(root+'/rooms', data), { onSuccess: refresh }),
    upload: useMutation((data: { name: string; text: string; dataClass: string }) => request.post(`${root}/rooms/${encodeURIComponent(room)}/upload`, data), { onSuccess: refresh }),
    file: useMutation((data:{name:string;contentBase64:string;dataClass:string})=>request.post(`${root}/rooms/${encodeURIComponent(room)}/file`,data),{onSuccess:refresh}),
    export: useMutation((answerId:string):Promise<{question:string;answer:string;sources:{anchor:string;name:string;version:string}[];notice:string}>=>request.post(`${root}/rooms/${encodeURIComponent(room)}/answers/${encodeURIComponent(answerId)}/export`,{})),
    microsoft: useMutation((sourceId:string):Promise<{url:string}>=>request.post(`${root}/rooms/${encodeURIComponent(room)}/sources/${encodeURIComponent(sourceId)}/microsoft`,{})),
    rename: useMutation((data:{name:string})=>request.post(`${root}/rooms/${encodeURIComponent(room)}/rename`,data),{onSuccess:refresh}),
    remove: useMutation(()=>request.delete(`${root}/rooms/${encodeURIComponent(room)}`),{onSuccess:refresh}),
    query: useMutation((data: { query: string; answer: boolean; modelSpec?: string; sourceIds?:string[] }): Promise<KnowledgeResult> => request.post(`${root}/rooms/${encodeURIComponent(room)}/query`, data), { onSuccess: refresh }),
    share: useMutation((data: { principalId: string; principalType: 'user' | 'group'; editor: boolean }) => request.post(`${root}/rooms/${encodeURIComponent(room)}/share`, data)),
  };
}
