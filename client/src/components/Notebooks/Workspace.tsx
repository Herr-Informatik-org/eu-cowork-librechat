import { ResourceType } from 'librechat-data-provider';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import React, { useState } from 'react';
import { useKnowledgeAccess, useKnowledgeHistory, useKnowledgeMutations, useKnowledgeRoom, useKnowledgeRooms, useKnowledgeStatus, useKnowledgeSources,useKnowledgePreview } from '~/data-provider/Notebooks';
import { useLocalize } from '~/hooks';
import './notebooks.css';

function sourceUrl(value?: string | null) {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && /^[a-z0-9-]+\.sharepoint\.com$/.test(url.hostname) ? url.href : null;
  } catch { return null; }
}

export default function Workspace() {
  const t = useLocalize();
  const status = useKnowledgeStatus();
  const rooms = useKnowledgeRooms();
  const [roomId, setRoomId] = useState('');
  const [name, setName] = useState('');
  const [zone, setZone] = useState('lokal');
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState(true);
  const [modelSpec, setModelSpec] = useState('');
  const [uploadName, setUploadName] = useState('');
  const [uploadText, setUploadText] = useState('');
  const [dataClass, setDataClass] = useState('lokal');
  const [after,setAfter]=useState('');
  const [pageStack,setPageStack]=useState<string[]>([]);
  const [rename,setRename]=useState('');
  const [file,setFile]=useState<File|null>(null);
  const [localError,setLocalError]=useState('');
  const [previewId,setPreviewId]=useState('');
  const [previewOrdinal,setPreviewOrdinal]=useState(0);
  const preview=useKnowledgePreview(roomId,previewId,previewOrdinal);
  const [sourceFilter,setSourceFilter]=useState<string[]|undefined>(undefined);
  const sources=useKnowledgeSources(roomId);
  const documents = useKnowledgeRoom(roomId,after);
  const history = useKnowledgeHistory(roomId);
  const mutations = useKnowledgeMutations(roomId);
  const access = useKnowledgeAccess(roomId, mutations.query.data?.ticket);
  const error = rooms.isError || documents.isError || history.isError || mutations.query.isError || mutations.upload.isError || mutations.create.isError || mutations.file.isError || mutations.rename.isError || mutations.remove.isError || mutations.microsoft.isError || mutations.share.isError || mutations.export.isError;
  const selected = rooms.data?.rooms.find((room) => room.id === roomId);
  return (
    <main className="knowledge-workspace" aria-label={t('com_ui_knowledge_title')}>
      <header className="knowledge-heading"><div><span>{t('com_ui_knowledge_pilot')}</span><h1>{t('com_ui_knowledge_title')}</h1></div><p>{t('com_ui_knowledge_description')}</p></header>
      {status.isError && <p role="alert">{t('com_ui_knowledge_unavailable')}</p>}
      {error && <p role="alert" className="knowledge-alert">{t('com_ui_knowledge_error')}</p>}
      {localError && <p role="alert">{localError}</p>}
      <div className="knowledge-grid">
        <aside>
          <h2>{t('com_ui_knowledge_rooms')}</h2>
          <ul>{rooms.data?.rooms.map((room) => <li key={room.id}><button aria-pressed={room.id === roomId} onClick={() => { setRoomId(room.id);setPreviewId('');setSourceFilter(undefined);setAfter('');setPageStack([]); mutations.query.reset(); }}>{room.name}<small>{room.zone}</small></button></li>)}</ul>
          <details><summary>{t('com_ui_knowledge_create')}</summary><form onSubmit={(event) => { event.preventDefault(); mutations.create.mutate({ name, zone }, { onSuccess: (room) => { setRoomId(room.id); setName(''); } }); }}>
            <label>{t('com_ui_knowledge_name')}<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>{t('com_ui_knowledge_zone')}<select value={zone} onChange={(event) => setZone(event.target.value)}>{['lokal','schweiz','europa','global'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <button disabled={mutations.create.isLoading}>{t('com_ui_knowledge_create')}</button>
          </form></details>
          {roomId && <><h2>{t('com_ui_knowledge_documents')}</h2><ul>{!documents.isError && documents.data?.documents.map((file) => <li key={file.id}><button onClick={()=>{setPreviewId(file.id);setPreviewOrdinal(0);}}>{file.name}</button>{file.path && <small>{file.path}</small>}<small>{file.state} · {file.data_class}</small></li>)}</ul><p className="knowledge-muted">{t('com_ui_knowledge_source_setup')}</p>
            {documents.data?.partial && <button onClick={()=>{setPageStack([...pageStack,after]);setAfter(documents.data?.next ?? '');}}>Weitere Dateien</button>}{after && <button onClick={()=>{setAfter(pageStack.at(-1) ?? '');setPageStack(pageStack.slice(0,-1));}}>Vorherige Dateien</button>}
            {sources.data?.sources.filter(source=>source.kind==='sharepoint').map(source=><button key={source.id} disabled={mutations.microsoft.isLoading || source.state==='setup-required'} onClick={()=>mutations.microsoft.mutate(source.id,{onSuccess:result=>{window.location.assign(result.url);}})}>{source.connected ? 'Microsoft-Identität erneut bestätigen' : 'Für diese Quelle mit Microsoft anmelden'}</button>)}
            <details><summary>Datei privat aufnehmen</summary><form onSubmit={async event=>{event.preventDefault();if(!file)return;setLocalError('');if(file.size>750000){setLocalError('Private Dateien sind auf 750 KB begrenzt. Grössere Dateien bitte als verwaltete SharePoint-/DFS-Quelle anbinden.');return;}const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));mutations.file.mutate({name:file.name,contentBase64:btoa(binary),dataClass},{onSuccess:()=>setFile(null)});}}><label>Datei (PDF, Word, Excel, PowerPoint, Text)<input type="file" accept=".pdf,.docx,.xlsx,.pptx,.txt,.md,.csv" onChange={event=>setFile(event.target.files?.[0] ?? null)}/></label><label>Datenklasse<select value={dataClass} onChange={event=>setDataClass(event.target.value)}>{['gesperrt','lokal','schweiz','europa','offen'].map(value=><option key={value}>{value}</option>)}</select></label><p>Bleibt persönlich, auch wenn dieser Wissensraum geteilt wird.</p><button disabled={!file || mutations.file.isLoading}>Datei lokal prüfen und aufnehmen</button></form></details>
            <details><summary>{t('com_ui_knowledge_upload')}</summary><form onSubmit={(event) => { event.preventDefault(); mutations.upload.mutate({ name: uploadName, text: uploadText, dataClass }, { onSuccess: () => { setUploadText(''); setUploadName(''); } }); }}>
              <label>{t('com_ui_knowledge_name')}<input required value={uploadName} onChange={(event) => setUploadName(event.target.value)} maxLength={150} /></label>
              <label>{t('com_ui_knowledge_text')}<textarea required value={uploadText} onChange={(event) => setUploadText(event.target.value)} maxLength={500000} /></label>
              <label>{t('com_ui_knowledge_class')}<select value={dataClass} onChange={(event) => setDataClass(event.target.value)}>{['gesperrt','lokal','schweiz','europa','offen'].map((value) => <option key={value}>{value}</option>)}</select></label>
              <p className="knowledge-muted">{t('com_ui_knowledge_private_upload')}</p><button disabled={mutations.upload.isLoading}>{t('com_ui_knowledge_upload')}</button>
            </form></details>
          </>}
        </aside>
        <section className="knowledge-conversation">
          {!roomId ? <p>{t('com_ui_knowledge_select')}</p> : <>
            <h2>{selected?.name}</h2>
            <details><summary>Wissensraum verwalten</summary><form onSubmit={event=>{event.preventDefault();mutations.rename.mutate({name:rename},{onSuccess:()=>setRename('')});}}><label>Neuer Name<input required maxLength={100} value={rename} onChange={event=>setRename(event.target.value)}/></label><button disabled={mutations.rename.isLoading}>Umbenennen</button></form>
              <p>Beim Teilen bleiben persönliche Quellrechte und private Uploads geschützt. Öffentliche Freigaben sind gesperrt.</p>
              <GenericGrantAccessDialog resourceType={ResourceType.NOTEBOOK} resourceDbId={roomId} resourceName={selected?.name}><button>Zugriffe verwalten</button></GenericGrantAccessDialog>
              <button onClick={()=>{if(window.confirm('Diesen Wissensraum und seine privaten Uploads löschen? Gemeinsame Unternehmensquellen bleiben erhalten.'))mutations.remove.mutate(undefined,{onSuccess:()=>{setRoomId('');mutations.query.reset();}});}} disabled={mutations.remove.isLoading}>Wissensraum löschen</button>
            </details>
            <p className="knowledge-muted">{t('com_ui_knowledge_model_zone')}: {status.data?.models?.find((model) => model.name===modelSpec)?.zone ?? status.data?.modelZone ?? 'global'} · {t('com_ui_knowledge_room_zone')}: {selected?.zone}</p>
            <form onSubmit={(event) => { event.preventDefault(); mutations.query.mutate({ query, answer, sourceIds:sourceFilter, ...(modelSpec ? { modelSpec } : {}) }); }}>
              <label>{t('com_ui_knowledge_question')}<textarea required value={query} onChange={(event) => setQuery(event.target.value)} maxLength={2000} /></label>
              <details><summary>Quellen für diese Frage auswählen</summary><label className="knowledge-inline"><input type="checkbox" checked={sourceFilter===undefined} onChange={event=>setSourceFilter(event.target.checked?undefined:[])}/>Alle im Raum verfügbaren Quellen einschliesslich eigener Uploads</label>{sources.data?.sources.map(source=><label key={source.id} className="knowledge-inline"><input type="checkbox" checked={sourceFilter?.includes(source.id)??false} disabled={sourceFilter===undefined} onChange={event=>setSourceFilter(event.target.checked?[...(sourceFilter??[]),source.id]:sourceFilter?.filter(id=>id!==source.id))}/>{source.kind} · {source.state}</label>)}</details>
              <label>{t('com_ui_knowledge_model')}<select value={modelSpec} onChange={(event) => setModelSpec(event.target.value)}><option value="">{t('com_ui_knowledge_default_model')}</option>{status.data?.models?.map((model) => <option key={model.name} value={model.name}>{model.label} · {model.zone}</option>)}</select></label>
              <label className="knowledge-inline"><input type="checkbox" checked={answer} onChange={(event) => setAnswer(event.target.checked)} />{t('com_ui_knowledge_answer')}</label>
              <button disabled={mutations.query.isLoading}>{mutations.query.isLoading ? t('com_ui_knowledge_checking') : t('com_ui_knowledge_search')}</button>
            </form>
            {mutations.query.data && (access.isError || access.data?.valid===false) && <p role="alert">{t('com_ui_knowledge_history_locked')}</p>}
            {mutations.query.data && !access.isError && access.data?.valid===true && <article className="knowledge-result"><p>{mutations.query.data.answer ?? (mutations.query.data.evidence.length ? t('com_ui_knowledge_found') : t('com_ui_knowledge_no_sources'))}</p>
              <details open><summary>{t('com_ui_knowledge_evidence')}</summary><p>{mutations.query.data.notice}</p><p className="knowledge-muted">{t('com_ui_knowledge_checked')}: {new Date(mutations.query.data.checkedAt).toLocaleString('de-CH')}</p><p className="knowledge-muted">{t('com_ui_knowledge_masking')}</p>
                {mutations.query.data.evidence.map((item) => <section key={item.anchor} id={item.anchor} className="knowledge-evidence"><h3>[{item.anchor}] {item.title}</h3><small>{item.position} · {item.version}</small><button onClick={()=>{setPreviewId(item.documentId);setPreviewOrdinal(Math.max(0,item.ordinal-1));}}>Textansicht an dieser Stelle</button><p className="knowledge-muted">{new Date(item.authorizedAt).toLocaleString('de-CH')}</p><blockquote>{item.text}</blockquote>{sourceUrl(item.webUrl) && <a href={sourceUrl(item.webUrl)!} target="_blank" rel="noreferrer noopener">{t('com_ui_knowledge_original')}</a>}</section>)}
                <ul>{mutations.query.data.sources.map((source) => <li key={source.id}>{source.name}: {source.authorization}<small>{t('com_ui_knowledge_sync')}: {source.synced_at ? new Date(source.synced_at).toLocaleString('de-CH') : t('com_ui_knowledge_unknown')}</small></li>)}</ul>
              </details>
            </article>}
            {previewId && <section className="knowledge-result" aria-label="Geprüfte Quellenansicht"><button onClick={()=>setPreviewId('')}>Vorschau schliessen</button>{preview.isError?<p role="alert">Die Quelle ist aktuell nicht zur Ansicht freigegeben.</p>:preview.data&&<><h3>{preview.data.name}</h3><small>{preview.data.version}</small><p>{preview.data.notice}</p>{preview.data.sections.map(section=><div key={section.ordinal}><strong>{section.position}</strong><p>{section.content}</p></div>)}{preview.data.next!==null&&<button onClick={()=>setPreviewOrdinal(preview.data!.next!)}>Weitere Abschnitte</button>}</>}</section>}
            <h2>{t('com_ui_knowledge_history')}</h2>
            {history.isError ? <p role="alert">{t('com_ui_knowledge_history_locked')}</p> : history.data?.answers.map((item) => <article className="knowledge-result" key={item.id}>{item.blocked ? <p>{item.notice}</p> : <><h3>{item.question}</h3><p>{item.answer}</p><button disabled={mutations.export.isLoading} onClick={()=>mutations.export.mutate(item.id,{onSuccess:result=>{const text='# '+result.question+'\n\n'+result.answer+'\n\nQuellen:\n'+result.sources.map(source=>`[${source.anchor}] ${source.name} · ${source.version}`).join('\n')+'\n\n'+result.notice;const url=URL.createObjectURL(new Blob([text],{type:'text/markdown;charset=utf-8'}));const link=document.createElement('a');link.href=url;link.download='kisuno-wissensraum-antwort.md';link.click();URL.revokeObjectURL(url);}})}>Antwort mit Quellen herunterladen</button></>}</article>)}
          </>}
        </section>
      </div>
    </main>
  );
}
