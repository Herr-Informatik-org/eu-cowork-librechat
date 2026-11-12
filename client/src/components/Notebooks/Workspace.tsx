import React, { useState } from 'react';
import { useKnowledgeAccess, useKnowledgeHistory, useKnowledgeMutations, useKnowledgeRoom, useKnowledgeRooms, useKnowledgeStatus } from '~/data-provider/Notebooks';
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
  const documents = useKnowledgeRoom(roomId);
  const history = useKnowledgeHistory(roomId);
  const mutations = useKnowledgeMutations(roomId);
  const access = useKnowledgeAccess(roomId, mutations.query.data?.ticket);
  const error = rooms.isError || documents.isError || history.isError || mutations.query.isError || mutations.upload.isError || mutations.create.isError;
  const selected = rooms.data?.rooms.find((room) => room.id === roomId);
  return (
    <main className="knowledge-workspace" aria-label={t('com_ui_knowledge_title')}>
      <header className="knowledge-heading"><div><span>{t('com_ui_knowledge_pilot')}</span><h1>{t('com_ui_knowledge_title')}</h1></div><p>{t('com_ui_knowledge_description')}</p></header>
      {status.isError && <p role="alert">{t('com_ui_knowledge_unavailable')}</p>}
      {error && <p role="alert" className="knowledge-alert">{t('com_ui_knowledge_error')}</p>}
      <div className="knowledge-grid">
        <aside>
          <h2>{t('com_ui_knowledge_rooms')}</h2>
          <ul>{rooms.data?.rooms.map((room) => <li key={room.id}><button aria-pressed={room.id === roomId} onClick={() => { setRoomId(room.id); mutations.query.reset(); }}>{room.name}<small>{room.zone}</small></button></li>)}</ul>
          <details><summary>{t('com_ui_knowledge_create')}</summary><form onSubmit={(event) => { event.preventDefault(); mutations.create.mutate({ name, zone }, { onSuccess: (room) => { setRoomId(room.id); setName(''); } }); }}>
            <label>{t('com_ui_knowledge_name')}<input required maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
            <label>{t('com_ui_knowledge_zone')}<select value={zone} onChange={(event) => setZone(event.target.value)}>{['lokal','schweiz','europa','global'].map((value) => <option key={value}>{value}</option>)}</select></label>
            <button disabled={mutations.create.isLoading}>{t('com_ui_knowledge_create')}</button>
          </form></details>
          {roomId && <><h2>{t('com_ui_knowledge_documents')}</h2><ul>{!documents.isError && documents.data?.documents.map((file) => <li key={file.id}><span>{file.name}</span><small>{file.state} · {file.data_class}</small></li>)}</ul><p className="knowledge-muted">{t('com_ui_knowledge_source_setup')}</p>
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
            <p className="knowledge-muted">{t('com_ui_knowledge_model_zone')}: {status.data?.models?.find((model) => model.name===modelSpec)?.zone ?? status.data?.modelZone ?? 'global'} · {t('com_ui_knowledge_room_zone')}: {selected?.zone}</p>
            <form onSubmit={(event) => { event.preventDefault(); mutations.query.mutate({ query, answer, ...(modelSpec ? { modelSpec } : {}) }); }}>
              <label>{t('com_ui_knowledge_question')}<textarea required value={query} onChange={(event) => setQuery(event.target.value)} maxLength={2000} /></label>
              <label>{t('com_ui_knowledge_model')}<select value={modelSpec} onChange={(event) => setModelSpec(event.target.value)}><option value="">{t('com_ui_knowledge_default_model')}</option>{status.data?.models?.map((model) => <option key={model.name} value={model.name}>{model.label} · {model.zone}</option>)}</select></label>
              <label className="knowledge-inline"><input type="checkbox" checked={answer} onChange={(event) => setAnswer(event.target.checked)} />{t('com_ui_knowledge_answer')}</label>
              <button disabled={mutations.query.isLoading}>{mutations.query.isLoading ? t('com_ui_knowledge_checking') : t('com_ui_knowledge_search')}</button>
            </form>
            {mutations.query.data && (access.isError || access.data?.valid===false) && <p role="alert">{t('com_ui_knowledge_history_locked')}</p>}
            {mutations.query.data && !access.isError && access.data?.valid===true && <article className="knowledge-result"><p>{mutations.query.data.answer ?? (mutations.query.data.evidence.length ? t('com_ui_knowledge_found') : t('com_ui_knowledge_no_sources'))}</p>
              <details open><summary>{t('com_ui_knowledge_evidence')}</summary><p>{mutations.query.data.notice}</p><p className="knowledge-muted">{t('com_ui_knowledge_checked')}: {new Date(mutations.query.data.checkedAt).toLocaleString('de-CH')}</p><p className="knowledge-muted">{t('com_ui_knowledge_masking')}</p>
                {mutations.query.data.evidence.map((item) => <section key={item.anchor} id={item.anchor} className="knowledge-evidence"><h3>[{item.anchor}] {item.title}</h3><small>{item.position} · {item.version}</small><p className="knowledge-muted">{new Date(item.authorizedAt).toLocaleString('de-CH')}</p><blockquote>{item.text}</blockquote>{sourceUrl(item.webUrl) && <a href={sourceUrl(item.webUrl)!} target="_blank" rel="noreferrer noopener">{t('com_ui_knowledge_original')}</a>}</section>)}
                <ul>{mutations.query.data.sources.map((source) => <li key={source.id}>{source.name}: {source.authorization}<small>{t('com_ui_knowledge_sync')}: {source.synced_at ? new Date(source.synced_at).toLocaleString('de-CH') : t('com_ui_knowledge_unknown')}</small></li>)}</ul>
              </details>
            </article>}
            <h2>{t('com_ui_knowledge_history')}</h2>
            {history.isError ? <p role="alert">{t('com_ui_knowledge_history_locked')}</p> : history.data?.answers.map((item) => <article className="knowledge-result" key={item.id}>{item.blocked ? <p>{item.notice}</p> : <><h3>{item.question}</h3><p>{item.answer}</p></>}</article>)}
          </>}
        </section>
      </div>
    </main>
  );
}
