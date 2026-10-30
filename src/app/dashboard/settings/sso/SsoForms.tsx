"use client";

import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useKeptSubmit } from "@/components/KeptForm";
import {
  addDomainAction,
  createScimTokenAction,
  mapGroupAction,
  removeDomainAction,
  removeSsoAction,
  revokeScimTokenAction,
  saveSsoAction,
  setEnforceAction,
  verifyDomainAction,
  type SsoFormState,
} from "@/app/actions/sso";
import { CopyField } from "../calling/CopyField";

/**
 * The single sign-on screen's controls. What exists opens read-only and
 * Change opens it; every result is said beside the button that produced it.
 */

function Note({ r }: { r: { ok: boolean; message: string } | null }) {
  if (!r) return null;
  return (
    <p className={`note ${r.ok ? "note--info" : "note--risk"}`} role="status" style={{ marginTop: 12 }}>
      {r.message}
    </p>
  );
}

function useRun() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);
  const run = (fn: () => Promise<{ ok: boolean; message: string }>) =>
    start(async () => {
      const r = await fn();
      setNote(r);
      if (r.ok) router.refresh();
    });
  return { pending, note, run };
}

// ---------------------------------------------------------------------------
// The identity provider
// ---------------------------------------------------------------------------

export function ProviderForm({ current, open: startOpen }: { current: { entityId: string; ssoUrl: string } | null; open: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const router = useRouter();
  const [state, submit, pending] = useActionState<SsoFormState, FormData>(saveSsoAction, null);
  const keep = useKeptSubmit(submit);
  const e = state?.ok ? undefined : state?.errors;
  useEffect(() => {
    if (state?.ok) {
      setOpen(false);
      router.refresh();
    }
  }, [state, router]);

  if (!open) {
    return (
      <div className="sso-acts">
        <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(true)}>
          Change
        </button>
        <RemoveProvider />
        {state?.ok && <Note r={state} />}
      </div>
    );
  }
  return (
    <form action={submit} onSubmit={keep} className="sso-form" noValidate>
      <div className="mv-field">
        <label className="mv-label" htmlFor="sso-metadata">
          Your provider&rsquo;s metadata XML<span className="mv-optional"> (fills the three below)</span>
        </label>
        <textarea id="sso-metadata" name="metadata" className="mv-input sso-mono" rows={4} placeholder={'<EntityDescriptor entityID="http://www.okta.com/exk1..." ...>'} aria-invalid={e?.metadata ? true : undefined} />
        {e?.metadata && <p className="mv-err">{e.metadata}</p>}
      </div>
      <div className="mv-grid">
        <div className="mv-field">
          <label className="mv-label" htmlFor="sso-entity">Entity ID</label>
          <input id="sso-entity" name="entityId" className="mv-input sso-mono" defaultValue={current?.entityId} placeholder="http://www.okta.com/exk1abcd2345" aria-invalid={e?.entityId ? true : undefined} />
          {e?.entityId && <p className="mv-err">{e.entityId}</p>}
        </div>
        <div className="mv-field">
          <label className="mv-label" htmlFor="sso-url">Sign-in URL</label>
          <input id="sso-url" name="ssoUrl" type="url" className="mv-input sso-mono" defaultValue={current?.ssoUrl} placeholder="https://yourcompany.okta.com/app/.../sso/saml" aria-invalid={e?.ssoUrl ? true : undefined} />
          {e?.ssoUrl && <p className="mv-err">{e.ssoUrl}</p>}
        </div>
        <div className="mv-field mv-field--wide">
          <label className="mv-label" htmlFor="sso-cert">Signing certificate</label>
          <textarea id="sso-cert" name="certificate" className="mv-input sso-mono" rows={4} placeholder={"-----BEGIN CERTIFICATE-----\nMIIDpDCCAoygAwIBAgIGAY...\n-----END CERTIFICATE-----"} aria-invalid={e?.certificate ? true : undefined} />
          {e?.certificate && <p className="mv-err">{e.certificate}</p>}
        </div>
      </div>
      {state && !state.ok && !state.errors && <Note r={state} />}
      <div className="sso-acts">
        {current && (
          <button type="button" className="btn btn--ghost" onClick={() => setOpen(false)}>
            Cancel
          </button>
        )}
        <button type="submit" className="btn btn--ink" disabled={pending}>
          {pending ? "Saving" : "Save"}
        </button>
      </div>
    </form>
  );
}

function RemoveProvider() {
  const { pending, note, run } = useRun();
  return (
    <>
      <button
        type="button"
        className="ws-link pf-danger"
        disabled={pending}
        onClick={() => {
          if (window.confirm("Turn single sign-on off? People sign in with Google or Microsoft again.")) run(removeSsoAction);
        }}
      >
        Turn off
      </button>
      {note && !note.ok && <Note r={note} />}
    </>
  );
}

export function EnforceButton({ on, disabledWhy, primary }: { on: boolean; disabledWhy: string | null; primary?: boolean }) {
  const { pending, note, run } = useRun();
  return (
    <span className="sso-enforce">
      <button
        type="button"
        className={`btn ${on || !primary ? "btn--ghost" : "btn--ink"}`}
        disabled={pending || (!on && !!disabledWhy)}
        title={!on && disabledWhy ? disabledWhy : undefined}
        onClick={() => {
          const msg = on
            ? "Make single sign-on optional? People may sign in with Google or Microsoft again."
            : "Require single sign-on? Everyone on your proved domains signs in through your provider from now on. Admins can still use Google or Microsoft.";
          if (window.confirm(msg)) run(() => setEnforceAction(!on));
        }}
      >
        {pending ? "Saving" : on ? "Make it optional" : "Require single sign-on"}
      </button>
      {note && <Note r={note} />}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Domains
// ---------------------------------------------------------------------------

export function DomainRow({ domain, verified, record }: { domain: string; verified: boolean; record: string }) {
  const { pending, note, run } = useRun();
  return (
    <li className="sso-domain">
      <div className="sso-domain__head">
        <span className="sso-domain__name">{domain}</span>
        <span className={`pill ${verified ? "pill--ok" : "pill--warn"}`}>
          <span className="pill__dot" />
          {verified ? "Proved" : "Waiting for DNS"}
        </span>
        <span className="sso-domain__acts">
          {!verified && (
            <button type="button" className="btn btn--ink btn--sm" disabled={pending} onClick={() => run(() => verifyDomainAction(domain))}>
              {pending ? "Checking" : "Check"}
            </button>
          )}
          <button
            type="button"
            className="ws-link pf-danger"
            disabled={pending}
            onClick={() => {
              if (window.confirm(`Remove ${domain}?`)) run(() => removeDomainAction(domain));
            }}
          >
            Remove
          </button>
        </span>
      </div>
      {!verified && <CopyField id={`txt-${domain}`} label={`TXT record on ${domain}`} value={record} />}
      {note && <Note r={note} />}
    </li>
  );
}

export function AddDomain() {
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [state, submit, pending] = useActionState<SsoFormState, FormData>(addDomainAction, null);
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state, router]);
  return (
    <form ref={formRef} action={submit} className="sso-inline">
      <label className="sr-only" htmlFor="sso-domain">Domain</label>
      <input id="sso-domain" name="domain" className="mv-input" placeholder="yourcompany.com" required />
      <button type="submit" className="btn btn--ghost" disabled={pending}>
        {pending ? "Adding" : "Add a domain"}
      </button>
      {state && <Note r={state} />}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Provisioning
// ---------------------------------------------------------------------------

export function NewToken() {
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();
  const [state, submit, pending] = useActionState<SsoFormState, FormData>(createScimTokenAction, null);
  useEffect(() => {
    if (state?.ok) {
      formRef.current?.reset();
      router.refresh();
    }
  }, [state, router]);
  return (
    <>
      <form ref={formRef} action={submit} className="sso-inline">
        <label className="sr-only" htmlFor="scim-label">Used by</label>
        <input id="scim-label" name="label" className="mv-input" placeholder="Used by, like Okta" maxLength={80} required />
        <button type="submit" className="btn btn--ghost" disabled={pending}>
          {pending ? "Making" : "Make a token"}
        </button>
      </form>
      {state?.token ? (
        <div className="sso-token" role="status">
          <p className="sso-token__title">Copy this token now. It is not shown again.</p>
          <CopyField id="scim-token" label="Bearer token" value={state.token} />
        </div>
      ) : (
        state && !state.ok && <Note r={state} />
      )}
    </>
  );
}

export function RevokeToken({ id, label }: { id: string; label: string }) {
  const { pending, note, run } = useRun();
  return (
    <>
      <button
        type="button"
        className="ws-link pf-danger"
        disabled={pending}
        onClick={() => {
          if (window.confirm(`Revoke the ${label} token? Your provider stops being able to add or remove people until it has a new one.`)) run(() => revokeScimTokenAction(id));
        }}
      >
        Revoke
      </button>
      {note && !note.ok && <Note r={note} />}
    </>
  );
}

export type RoleReach = { key: string; label: string; at: string[] };
export type Place = { id: string; label: string };

export function GroupMapping({
  groupId,
  current,
  roles,
  places,
}: {
  groupId: string;
  current: { role: string | null; roleLabel: string | null; nodeId: string | null; nodeName: string | null };
  roles: RoleReach[];
  places: Place[];
}) {
  const [open, setOpen] = useState(false);
  const [role, setRole] = useState(current.role ?? "");
  const [node, setNode] = useState(current.nodeId ?? "");
  const { pending, note, run } = useRun();
  const reach = roles.find((r) => r.key === role)?.at ?? [];
  const where = places.filter((p) => reach.includes(p.id));
  useEffect(() => {
    if (role && !reach.includes(node)) setNode(where[0]?.id ?? "");
  }, [role]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) {
    return (
      <span className="sso-map">
        <span className={current.role ? undefined : "sso-muted"}>
          {current.role ? `${current.roleLabel ?? current.role} at ${current.nodeName ?? "the organisation"}` : "Nothing yet"}
        </span>
        <button type="button" className="ws-link" onClick={() => setOpen(true)}>
          Change
        </button>
        {note && <Note r={note} />}
      </span>
    );
  }
  return (
    <span className="sso-map sso-map--open">
      <label className="sr-only" htmlFor={`g-role-${groupId}`}>Role</label>
      <select id={`g-role-${groupId}`} className="cl-select" value={role} onChange={(e) => setRole(e.target.value)}>
        <option value="">Gives nothing</option>
        {roles.map((r) => (
          <option key={r.key} value={r.key}>
            {r.label}
          </option>
        ))}
      </select>
      {role && (
        <>
          <label className="sr-only" htmlFor={`g-node-${groupId}`}>At</label>
          <select id={`g-node-${groupId}`} className="cl-select" value={node} onChange={(e) => setNode(e.target.value)}>
            {where.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </>
      )}
      <button
        type="button"
        className="btn btn--ink btn--sm"
        disabled={pending || (!!role && !node)}
        onClick={() =>
          run(async () => {
            const r = await mapGroupAction({ groupId, role, nodeId: node });
            if (r.ok) setOpen(false);
            return r;
          })
        }
      >
        {pending ? "Saving" : "Save"}
      </button>
      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {note && !note.ok && <Note r={note} />}
    </span>
  );
}
