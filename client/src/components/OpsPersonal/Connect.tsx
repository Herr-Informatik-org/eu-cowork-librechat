import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import type { OpsAuthorization, OpsPersonalScope } from 'librechat-data-provider';
import { useOpsPersonal } from '~/data-provider/OpsPersonal';
import useAuthRedirect from '~/routes/useAuthRedirect';
import { useLocalize } from '~/hooks';

export default function OpsPersonalConnect() {
  const localize = useLocalize();
  const { isAuthenticated } = useAuthRedirect();
  const [search] = useSearchParams();
  const [brain, setBrain] = useState(false);
  const [background, setBackground] = useState(false);
  const [redirectError, setRedirectError] = useState(false);
  const authorization = useMemo<OpsAuthorization | null>(() => {
    if (!search.has('client_id')) return null;
    const input = Object.fromEntries(search);
    if (
      (search.size !== 7 && search.size !== 8) ||
      Object.keys(input).length !== search.size ||
      Object.keys(input).some(
        (key) =>
          ![
            'client_id',
            'redirect_uri',
            'response_type',
            'state',
            'code_challenge',
            'code_challenge_method',
            'ops_user_id',
            'scope',
          ].includes(key),
      ) ||
      input.response_type !== 'code' ||
      input.client_id !== 'ops' ||
      input.redirect_uri !== 'https://ops.rzcloud.ch/functions/v1/kisuno-personal/callback' ||
      input.code_challenge_method !== 'S256' ||
      !input.state ||
      !input.code_challenge ||
      !input.ops_user_id
    )
      return null;
    return {
      response_type: input.response_type,
      client_id: input.client_id,
      redirect_uri: input.redirect_uri,
      code_challenge_method: input.code_challenge_method,
      state: input.state,
      code_challenge: input.code_challenge,
      ops_user_id: input.ops_user_id,
      ...(input.scope === undefined ? {} : { scope: input.scope }),
    };
  }, [search]);
  const { consent, grants, approve, revoke } = useOpsPersonal(authorization);
  useEffect(() => {
    setBrain(false);
    setBackground(false);
  }, [authorization, consent.data?.account]);
  useEffect(() => {
    const meta = document.createElement('meta');
    meta.name = 'referrer';
    meta.content = 'no-referrer';
    document.head.appendChild(meta);
    return () => meta.remove();
  }, []);
  const follow = (target: string) => {
    const url = new URL(target);
    if (
      url.origin !== 'https://ops.rzcloud.ch' ||
      url.pathname !== '/functions/v1/kisuno-personal/callback' ||
      url.username ||
      url.password ||
      url.hash
    ) {
      setRedirectError(true);
      return;
    }
    window.location.assign(url.href);
  };
  const accept = async () => {
    const scopes: OpsPersonalScope[] = ['mail:compose', 'skills:use'];
    if (brain && consent.data?.optional_scopes.includes('brain:read')) scopes.push('brain:read');
    if (background && consent.data?.optional_scopes.includes('mail:background'))
      scopes.push('mail:background');
    try {
      const result = await approve.mutateAsync(scopes);
      follow(result.redirect_uri);
    } catch {
      /* The mutation exposes a fixed error message below. */
    }
  };
  const decline = () => {
    if (!consent.data) return;
    const target = new URL(consent.data.authorization.redirect_uri);
    target.searchParams.set('error', 'access_denied');
    target.searchParams.set('state', consent.data.authorization.state);
    follow(target.href);
  };
  if (!isAuthenticated) return <p role="status">{localize('com_ui_ops_personal_loading')}</p>;
  const failed =
    (search.size > 0 && !authorization) ||
    consent.isError ||
    grants.isError ||
    approve.isError ||
    revoke.isError ||
    redirectError;
  return (
    <main
      className="mx-auto flex max-w-2xl flex-col gap-5 p-6"
      aria-labelledby="ops-connect-heading"
    >
      <h1 id="ops-connect-heading" className="text-2xl font-semibold">
        {localize('com_ui_ops_personal_title')}
      </h1>
      <p>{localize('com_ui_ops_personal_intro')}</p>
      {failed && (
        <p role="alert" className="text-red-600">
          {localize('com_ui_ops_personal_error')}
        </p>
      )}
      {authorization && consent.isLoading && (
        <p role="status">{localize('com_ui_ops_personal_loading')}</p>
      )}
      {consent.data && (
        <section
          className="flex flex-col gap-4 rounded-xl border p-5"
          aria-label={localize('com_ui_ops_personal_consent')}
        >
          <p>{localize('com_ui_ops_personal_account', { account: consent.data.account })}</p>
          <p>{localize('com_ui_ops_personal_permissions')}</p>
          {consent.data.optional_scopes.includes('brain:read') && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={brain}
                onChange={(event) => setBrain(event.target.checked)}
              />
              {localize('com_ui_ops_personal_brain')}
            </label>
          )}
          {consent.data.optional_scopes.includes('mail:background') && (
            <label className="flex items-start gap-3">
              <input
                type="checkbox"
                checked={background}
                onChange={(event) => setBackground(event.target.checked)}
              />
              {localize('com_ui_ops_personal_background')}
            </label>
          )}
          <p className="text-sm">{localize('com_ui_ops_personal_boundary')}</p>
          <div className="flex gap-3">
            <button
              type="button"
              className="btn btn-primary"
              disabled={approve.isLoading}
              onClick={() => void accept()}
            >
              {localize('com_ui_ops_personal_allow')}
            </button>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={approve.isLoading}
              onClick={decline}
            >
              {localize('com_ui_ops_personal_deny')}
            </button>
          </div>
        </section>
      )}
      <section aria-labelledby="ops-grants-heading" className="flex flex-col gap-3">
        <h2 id="ops-grants-heading" className="text-xl font-semibold">
          {localize('com_ui_ops_personal_connections')}
        </h2>
        {grants.isLoading && <p role="status">{localize('com_ui_ops_personal_loading')}</p>}
        {grants.data?.grants.length === 0 && <p>{localize('com_ui_ops_personal_none')}</p>}
        {grants.data?.grants.map((grant) => (
          <div
            key={grant.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
          >
            <div>
              <p>{localize('com_ui_ops_personal_client')}</p>
              <p className="text-sm">
                {localize('com_ui_ops_personal_until', {
                  date: new Date(grant.expires_at).toLocaleDateString(),
                })}
              </p>
              <p className="text-sm">
                {grant.scopes.includes('brain:read')
                  ? localize('com_ui_ops_personal_brain_on')
                  : localize('com_ui_ops_personal_brain_off')}
              </p>
              <p className="text-sm">
                {grant.scopes.includes('mail:background')
                  ? localize('com_ui_ops_personal_background_on')
                  : localize('com_ui_ops_personal_background_off')}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={revoke.isLoading}
              onClick={() => revoke.mutate(grant.id)}
            >
              {localize('com_ui_ops_personal_revoke')}
            </button>
          </div>
        ))}
      </section>
      <Link to="/c/new" className="underline">
        {localize('com_ui_ops_personal_back')}
      </Link>
    </main>
  );
}
