import { useEffect, useRef, useState } from 'react';
import { SearchCheck, Loader2 } from 'lucide-react';
import { MAIL_RESEARCH_CONSENT_VERSION } from 'librechat-data-provider';
import type {
  MailResearchCustomer,
  MailResearchJob,
  MailResearchProfile,
  MailResearchSettings,
  MailResearchSkill,
  MailResearchSkillInput,
  MailResearchSource,
  MailWorkspaceResult,
} from 'librechat-data-provider';
import {
  useMailResearchActions,
  useMailResearchCustomers,
  useMailResearchJobs,
  useMailResearchSettings,
} from '~/data-provider/Mail/research';
import { useLocalize } from '~/hooks';
import { mailActionError } from './Followup';
import { isMailEscape, isMailSubmitShortcut } from './Shortcuts';

const activeJob = (job: MailResearchJob) => job.status === 'queued' || job.status === 'running';
const labels = {
  queued: 'com_ui_mail_research_queued',
  running: 'com_ui_mail_research_running',
  completed: 'com_ui_mail_research_completed',
  failed: 'com_ui_mail_research_failed',
  cancelled: 'com_ui_mail_research_cancelled',
} as const;
const sourceLabels = { odoo: 'Odoo', ops: 'OPS' };
// Topics are literal search terms, never patterns or query fragments.
// eslint-disable-next-line no-control-regex
const literal = /^[^%_*\r\n\u0000-\u001f]+$/;
const sourceStatuses = {
  pending: 'com_ui_mail_research_source_pending',
  complete: 'com_ui_mail_research_source_complete',
  unavailable: 'com_ui_mail_research_source_unavailable',
} as const;
type Selection = { profileId: string; customer?: MailResearchCustomer };

function evidenceUrl(value?: string): string | undefined {
  if (!value || /[\s\\]/.test(value)) return;
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password && !url.port) return url.href;
  } catch {
    return;
  }
}
function timestamp(value?: string): string {
  return value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString('de-CH')
    : '–';
}

export function MailResearchProgress() {
  const t = useLocalize();
  const settings = useMailResearchSettings();
  const jobs = useMailResearchJobs(settings.data?.available === true);
  const actions = useMailResearchActions();
  const running = jobs.data?.filter(activeJob) || [];
  if (settings.data?.available !== true || settings.isError || jobs.isError || !running.length)
    return null;
  return (
    <div className="mail-research-progress" aria-label={t('com_ui_mail_research_jobs')}>
      {running.map((job) => (
        <div key={job.id} className="mail-job-heading">
          <Loader2 size={14} className="animate-spin" aria-hidden="true" />
          <span role="status">
            {job.skill.name} · {t(labels[job.status])} ·{' '}
            {job.sources.filter((source) => source.status !== 'pending').length}/
            {job.sources.length}
          </span>
          <button
            className="mail-button"
            disabled={actions.cancel.isLoading}
            onClick={() => actions.cancel.mutate(job.id)}
          >
            {t('com_ui_mail_research_cancel')}
          </button>
        </div>
      ))}
      {actions.cancel.isError && <p role="alert">{t('com_ui_mail_research_error')}</p>}
    </div>
  );
}

function SkillEditor({
  initial,
  settings,
  onSaved,
  onClose,
}: {
  initial?: MailResearchSkill;
  settings: MailResearchSettings;
  onSaved: (skill: MailResearchSkill) => void;
  onClose: () => void;
}) {
  const t = useLocalize();
  const actions = useMailResearchActions();
  const [id] = useState(() => initial?.id || `research-${crypto.randomUUID()}`);
  const [form, setForm] = useState<MailResearchSkillInput>(() => ({
    expectedRevision: initial?.revision || '',
    name: initial?.name || '',
    instructions: initial?.instructions || '',
    topic: initial?.topic || '',
    lookbackMonths: initial?.lookbackMonths || 12,
    sources: initial?.sources || [],
    consentVersion: MAIL_RESEARCH_CONSENT_VERSION,
  }));
  const [consent, setConsent] = useState(false);
  const submitting = useRef(false);
  const name = useRef<HTMLInputElement>(null);
  useEffect(() => {
    name.current?.focus();
  }, []);
  const valid =
    consent &&
    settings.available &&
    form.name.trim().length > 0 &&
    form.instructions.trim().length > 0 &&
    form.topic.trim().length >= 2 &&
    form.topic.trim().length <= 120 &&
    literal.test(form.topic.trim()) &&
    form.sources.length > 0 &&
    Number.isInteger(form.lookbackMonths) &&
    form.lookbackMonths >= 1 &&
    form.lookbackMonths <= 36 &&
    form.sources.every((source) => settings.profiles.some((profile) => profile.kind === source));
  const save = () => {
    if (!valid || submitting.current || actions.save.isLoading) return;
    submitting.current = true;
    actions.save.mutate(
      { id, input: form },
      {
        onSuccess: onSaved,
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };
  return (
    <form
      className="mail-research-skill mail-card"
      onSubmit={(event) => {
        event.preventDefault();
        save();
      }}
      onKeyDown={(event) => {
        if (isMailSubmitShortcut(event)) {
          event.preventDefault();
          event.stopPropagation();
          save();
        }
      }}
    >
      <p>{t('com_ui_mail_research_skill_scope')}</p>
      {!initial && (
        <button
          className="mail-button"
          type="button"
          onClick={() => {
            setConsent(false);
            setForm({
              ...form,
              name: t('com_ui_mail_research_template_name'),
              instructions: t('com_ui_mail_research_template_instructions'),
              topic: 'Veeam',
              lookbackMonths: 12,
              sources: (['odoo', 'ops'] as const).filter((source) =>
                settings.profiles.some((profile) => profile.kind === source),
              ),
            });
          }}
        >
          {t('com_ui_mail_research_template')}
        </button>
      )}

      <label>
        {t('com_ui_mail_research_skill_name')}
        <input
          ref={name}
          value={form.name}
          maxLength={100}
          onChange={(event) => setForm({ ...form, name: event.target.value })}
        />
      </label>
      <label>
        {t('com_ui_mail_research_instructions')}
        <textarea
          rows={4}
          maxLength={4000}
          value={form.instructions}
          onChange={(event) => setForm({ ...form, instructions: event.target.value })}
        />
      </label>
      <label>
        {t('com_ui_mail_research_topic')}
        <input
          minLength={2}
          maxLength={120}
          value={form.topic}
          onChange={(event) => setForm({ ...form, topic: event.target.value })}
        />
      </label>
      <label>
        {t('com_ui_mail_research_months')}
        <input
          type="number"
          min={1}
          max={36}
          value={form.lookbackMonths}
          onChange={(event) => setForm({ ...form, lookbackMonths: Number(event.target.value) })}
        />
      </label>
      <fieldset>
        <legend>{t('com_ui_mail_research_sources')}</legend>
        {(['odoo', 'ops'] as const).map((source) => (
          <label className="mail-check" key={source}>
            <input
              type="checkbox"
              checked={form.sources.includes(source)}
              disabled={!settings.profiles.some((profile) => profile.kind === source)}
              onChange={(event) =>
                setForm({
                  ...form,
                  sources: event.target.checked
                    ? [...form.sources, source]
                    : form.sources.filter((item) => item !== source),
                })
              }
            />
            {sourceLabels[source]}
          </label>
        ))}
      </fieldset>
      <p className="mail-muted">
        {t('com_ui_mail_research_model', {
          model: settings.modelLabel || t('com_ui_mail_research_unknown_model'),
        })}
      </p>
      <label className="mail-check">
        <input
          type="checkbox"
          checked={consent}
          onChange={(event) => setConsent(event.target.checked)}
        />
        {t('com_ui_mail_research_consent')}
      </label>
      <div className="mail-body-actions">
        <button
          className="mail-button primary"
          disabled={!valid || actions.save.isLoading}
          type="submit"
        >
          {t('com_ui_mail_research_save')}
        </button>
        <button
          className="mail-button"
          type="button"
          disabled={actions.save.isLoading}
          onClick={onClose}
        >
          {t('com_ui_mail_cancel')}
        </button>
      </div>
      {actions.save.isError && (
        <p className="mail-error" role="alert">
          {mailActionError(actions.save.error, t('com_ui_mail_research_error'))}
        </p>
      )}
    </form>
  );
}

function CustomerPicker({
  kind,
  profiles,
  selection,
  onChange,
}: {
  kind: MailResearchSource;
  profiles: MailResearchProfile[];
  selection?: Selection;
  onChange: (value: Selection) => void;
}) {
  const t = useLocalize();
  const [search, setSearch] = useState('');
  const [submitted, setSubmitted] = useState('');
  const query = useMailResearchCustomers(
    selection?.profileId || '',
    submitted,
    !!selection?.profileId,
  );
  return (
    <fieldset className="mail-research-customer">
      <legend>{sourceLabels[kind]}</legend>
      <label>
        {t('com_ui_mail_research_profile')}
        <select
          value={selection?.profileId || ''}
          onChange={(event) => {
            setSubmitted('');
            setSearch('');
            onChange({ profileId: event.target.value });
          }}
        >
          <option value="">{t('com_ui_mail_research_choose_profile')}</option>
          {profiles
            .filter((profile) => profile.kind === kind)
            .map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.label}
              </option>
            ))}
        </select>
      </label>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (search.trim().length >= 2) setSubmitted(search.trim());
        }}
      >
        <label>
          {t('com_ui_mail_research_customer_search')}
          <input
            value={search}
            maxLength={100}
            disabled={!selection?.profileId}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          className="mail-button"
          type="submit"
          disabled={!selection?.profileId || search.trim().length < 2 || query.isFetching}
        >
          {t('com_ui_search')}
        </button>
      </form>
      {selection?.customer && (
        <p>
          {t('com_ui_mail_research_selected_customer')}: <bdi>{selection.customer.name}</bdi>
        </p>
      )}
      {query.isFetching && <p role="status">{t('com_ui_loading')}</p>}
      {query.isError && <p role="alert">{t('com_ui_mail_research_customer_error')}</p>}
      {query.data && !query.isError && (
        <ul>
          {query.data.map((customer) => (
            <li key={customer.id}>
              <button
                className="mail-button"
                onClick={() =>
                  selection?.profileId && onChange({ profileId: selection.profileId, customer })
                }
              >
                <bdi>{customer.name}</bdi> · {customer.id}
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.data?.length === 0 && <p>{t('com_ui_mail_research_no_customer')}</p>}
    </fieldset>
  );
}

function ResearchResult({
  job,
  onUse,
  disabled,
}: {
  job: MailResearchJob;
  onUse: (text: string) => void;
  disabled: boolean;
}) {
  const t = useLocalize();
  const actions = useMailResearchActions();
  return (
    <section className="mail-research-result" aria-label={t('com_ui_mail_research_report')}>
      <h4>
        {job.skill.name} · {t(labels[job.status])}
      </h4>
      <p className="mail-muted">
        {t('com_ui_mail_research_asof')}: {timestamp(job.completedAt || job.createdAt)}
      </p>
      <ul>
        {job.sources.map((source) => (
          <li key={source.profileId}>
            {sourceLabels[source.kind]} ·{' '}
            {source.customer?.name || t('com_ui_mail_research_unknown_customer')} ·{' '}
            {t(sourceStatuses[source.status])}
            {source.truncated ? ` · ${t('com_ui_mail_research_truncated')}` : ''}
          </li>
        ))}
      </ul>
      {activeJob(job) && (
        <button
          className="mail-button"
          disabled={actions.cancel.isLoading}
          onClick={() => actions.cancel.mutate(job.id)}
        >
          {t('com_ui_mail_research_cancel')}
        </button>
      )}
      {job.error && (
        <p className="mail-error" role="alert">
          {job.error}
        </p>
      )}
      {job.warnings.map((warning, index) => (
        <p className="mail-notice" key={index}>
          {warning}
        </p>
      ))}
      {job.answer && <pre>{job.answer}</pre>}
      {job.evidence.map((item) => (
        <details key={item.id}>
          <summary>
            {sourceLabels[item.source]} · {item.title} · {timestamp(item.updatedAt)}
          </summary>
          <dl>
            {item.fields.map((field, index) => (
              <div key={index}>
                <dt>{field.label}</dt>
                <dd>{field.value}</dd>
              </div>
            ))}
          </dl>
          {evidenceUrl(item.url) && (
            <a href={evidenceUrl(item.url)} target="_blank" rel="noopener noreferrer">
              {t('com_ui_mail_research_open_source')}
            </a>
          )}
        </details>
      ))}
      {job.status === 'completed' && job.answer && (
        <button
          className="mail-button"
          disabled={disabled}
          onClick={() =>
            onUse(
              `${job.answer}\n\n${t('com_ui_mail_research_asof')}: ${timestamp(job.completedAt || job.createdAt)}`,
            )
          }
        >
          {t('com_ui_mail_research_use')}
        </button>
      )}
    </section>
  );
}

type Props = {
  result: MailWorkspaceResult;
  disabled: boolean;
  openRequest?: number;
  onUse: (text: string) => void;
  transferDisabled?: boolean;
};
export function MailResearch(props: Props) {
  return <Research key={`${props.result.id}:${props.result.revision}`} {...props} />;
}
function Research({ result, disabled, openRequest = 0, onUse, transferDisabled = false }: Props) {
  const t = useLocalize();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const skillChoice = useRef<HTMLSelectElement>(null);
  const settings = useMailResearchSettings(open);
  const jobs = useMailResearchJobs(open && settings.data?.available === true);
  const actions = useMailResearchActions();
  const [selectedId, setSelectedId] = useState('');
  const [saved, setSaved] = useState<MailResearchSkill>();
  const [editing, setEditing] = useState(false);
  const [editSkill, setEditSkill] = useState<MailResearchSkill>();
  const [selections, setSelections] = useState<Partial<Record<MailResearchSource, Selection>>>({});
  const [confirmed, setConfirmed] = useState(false);
  const [reference, setReference] = useState('');
  const submitting = useRef(false);
  const request = useRef({ hash: '', id: '' });
  const skill =
    (saved?.id === selectedId ? saved : undefined) ||
    settings.data?.skills.find((item) => item.id === selectedId);
  const matchingJobs =
    jobs.data?.filter((item) => item.resultId === result.id && item.revision === result.revision) ||
    [];
  const accepted = actions.run.data;
  if (
    accepted?.resultId === result.id &&
    accepted.revision === result.revision &&
    !matchingJobs.some((item) => item.id === accepted.id)
  )
    matchingJobs.push(accepted);
  const job = matchingJobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
  const consentCurrent = settings.data?.consentVersion === MAIL_RESEARCH_CONSENT_VERSION || !!saved;
  const valid =
    consentCurrent &&
    (!reference.trim() || literal.test(reference.trim())) &&
    !disabled &&
    !editing &&
    settings.data?.available === true &&
    !settings.isError &&
    !!skill &&
    skill.sources.every((kind) => {
      const selected = selections[kind];
      return (
        !!selected?.customer &&
        settings.data?.profiles.some(
          (profile) => profile.id === selected.profileId && profile.kind === kind,
        )
      );
    }) &&
    (skill.sources.length < 2 || confirmed) &&
    !actions.run.isLoading &&
    !(job && activeJob(job));
  const start = () => {
    if (!valid || !skill || submitting.current) return;
    const input = {
      revision: result.revision,
      skillId: skill.id,
      skillRevision: skill.revision,
      selections: skill.sources.map((kind) => ({
        profileId: selections[kind]!.profileId,
        customerId: selections[kind]!.customer!.id,
      })),
      customersConfirmed: skill.sources.length < 2 || confirmed,
      ...(reference.trim() ? { reference: reference.trim() } : {}),
    };
    const hash = JSON.stringify(input);
    if (request.current.hash !== hash) request.current = { hash, id: crypto.randomUUID() };
    submitting.current = true;
    actions.run.mutate(
      { id: result.id, input: { ...input, requestId: request.current.id } },
      {
        onSettled: () => {
          submitting.current = false;
        },
      },
    );
  };
  useEffect(() => {
    if (openRequest > 0 && !disabled) setOpen(true);
  }, [openRequest, disabled]);
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open, openRequest]);
  return (
    <section className="mail-research" data-mail-shortcuts="off">
      <button
        ref={trigger}
        className="mail-button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
      >
        <SearchCheck size={15} aria-hidden="true" />
        {t('com_ui_mail_research_open')}
      </button>
      {open && (
        <section
          className="mail-card"
          onKeyDown={(event) => {
            if (isMailSubmitShortcut(event)) {
              event.preventDefault();
              event.stopPropagation();
              start();
            } else if (isMailEscape(event)) {
              event.preventDefault();
              event.stopPropagation();
              setOpen(false);
              trigger.current?.focus();
            }
          }}
        >
          <div className="mail-settings-heading">
            <h3 ref={heading} tabIndex={-1}>
              {t('com_ui_mail_research_open')}
            </h3>
            <button
              className="mail-button"
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              {t('com_ui_mail_close')}
            </button>
          </div>
          <p className="mail-muted">{t('com_ui_mail_research_scope')}</p>
          {settings.isLoading && <p role="status">{t('com_ui_loading')}</p>}
          {(settings.isError || settings.data?.available === false) && (
            <p role="status">{settings.data?.reason || t('com_ui_mail_research_unavailable')}</p>
          )}
          {settings.data?.available && !settings.isError && (
            <>
              {!consentCurrent && (
                <p className="mail-notice">{t('com_ui_mail_research_renew_consent')}</p>
              )}
              <label>
                {t('com_ui_mail_research_skill')}
                <select
                  ref={skillChoice}
                  value={selectedId}
                  disabled={editing}
                  onChange={(event) => {
                    setSelectedId(event.target.value);
                    setSelections({});
                    setConfirmed(false);
                  }}
                >
                  <option value="">{t('com_ui_mail_research_choose_skill')}</option>
                  {[
                    ...settings.data.skills,
                    ...(saved && !settings.data.skills.some((item) => item.id === saved.id)
                      ? [saved]
                      : []),
                  ].map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="mail-body-actions">
                <button
                  className="mail-button"
                  disabled={editing}
                  onClick={() => {
                    setEditSkill(undefined);
                    setEditing(true);
                  }}
                >
                  {t('com_ui_mail_research_new_skill')}
                </button>
                <button
                  className="mail-button"
                  disabled={!skill || editing}
                  onClick={() => {
                    setEditSkill(skill);
                    setEditing(true);
                  }}
                >
                  {t('com_ui_mail_research_edit_skill')}
                </button>
              </div>
              {editing && (
                <SkillEditor
                  key={editSkill?.id || 'new'}
                  initial={editSkill}
                  settings={settings.data}
                  onClose={() => {
                    setEditing(false);
                    requestAnimationFrame(() => skillChoice.current?.focus());
                  }}
                  onSaved={(value) => {
                    setSaved(value);
                    setSelectedId(value.id);
                    setSelections({});
                    setConfirmed(false);
                    setEditing(false);
                    requestAnimationFrame(() => skillChoice.current?.focus());
                  }}
                />
              )}
              {skill && !editing && consentCurrent && (
                <>
                  <p className="mail-muted">
                    {skill.topic} · {skill.lookbackMonths} {t('com_ui_mail_research_months')}
                  </p>
                  {skill.sources.map((kind) => (
                    <CustomerPicker
                      key={`${skill.id}:${skill.revision}:${kind}`}
                      kind={kind}
                      profiles={settings.data!.profiles}
                      selection={selections[kind]}
                      onChange={(value) => {
                        setSelections((previous) => ({ ...previous, [kind]: value }));
                        setConfirmed(false);
                      }}
                    />
                  ))}
                  {skill.sources.length > 1 && (
                    <label className="mail-check">
                      <input
                        type="checkbox"
                        checked={confirmed}
                        onChange={(event) => setConfirmed(event.target.checked)}
                      />
                      {t('com_ui_mail_research_confirm_customer')}
                    </label>
                  )}
                  <label>
                    {t('com_ui_mail_research_reference')}
                    <input
                      value={reference}
                      maxLength={120}
                      onChange={(event) => setReference(event.target.value)}
                      aria-keyshortcuts="Control+Enter Meta+Enter"
                    />
                  </label>
                  <button className="mail-button primary" disabled={!valid} onClick={start}>
                    {t('com_ui_mail_research_start')}
                  </button>
                  <p className="mail-muted">{t('com_ui_mail_research_shortcut')}</p>
                </>
              )}
            </>
          )}
          {actions.run.isError && (
            <p className="mail-error" role="alert">
              {mailActionError(actions.run.error, t('com_ui_mail_research_error'))}
            </p>
          )}
          {job && settings.data?.available === true && !settings.isError && !jobs.isError && (
            <ResearchResult
              job={job}
              onUse={onUse}
              disabled={
                disabled || transferDisabled || editing || settings.data?.available !== true
              }
            />
          )}
        </section>
      )}
    </section>
  );
}
