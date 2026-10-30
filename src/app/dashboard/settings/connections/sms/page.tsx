import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { withTenant } from "@/lib/db";
import { smsSettings, type SmsTemplateView } from "@/lib/sms";
import { SMS_STATE_WORDS } from "@/lib/sms-rules";
import { VOICE_WORDS } from "@/lib/message-rules";
import { saveSmsAction } from "@/app/actions/sms";
import { PageHead } from "@/components/shell/PageHead";
import { KeptForm } from "@/components/KeptForm";
import { Chat } from "@/components/icons";
import "../whatsapp/whatsapp.css";
import "./sms.css";

/**
 * SMS for the service messages WhatsApp cannot carry: the developer's DLT
 * registration (entity id and header) and the id DLT gave each message.
 *
 * Opens read-only; changing the ids is a decision, so it is "Change" first.
 * Each message shows the exact words to register on DLT beside the id it
 * got, because DLT drops anything that is not word for word.
 */

const TONE = { SENDS: "ok", REWORDED: "warn", MISSING: "quiet" } as const;

export default async function SmsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  if (!viewer.authz.can("integration:manage")) redirect("/dashboard/settings/connections");
  const orgId = viewer.state.org.id;
  const q = await searchParams;
  const [root] = await withTenant(orgId, (sql) => sql<{ id: string }[]>`
    SELECT id FROM scope_nodes WHERE org_id = ${orgId} AND kind = 'ORG' LIMIT 1`);
  const s = await smsSettings(orgId, root.id);
  const editing = q.edit === "1" || !s.sender;
  const registered = s.templates.filter((t) => t.state === "SENDS").length;

  return (
    <>
      <PageHead
        title={
          <>
            <span className="conn__titlemark wa-mark">
              <Chat size={18} />
            </span>
            Service <span className="em">SMS</span>
          </>
        }
        meta={
          s.sender
            ? `Header ${s.sender.header} · ${registered.toLocaleString("en-IN")} of ${s.templates.length.toLocaleString("en-IN")} messages registered`
            : "For buyers WhatsApp cannot reach."
        }
        back={{ label: "Connected accounts", href: "/dashboard/settings/connections" }}
        action={
          editing ? (
            <>
              {s.sender && (
                <Link href="/dashboard/settings/connections/sms" className="btn btn--ghost">
                  Cancel
                </Link>
              )}
              <button type="submit" form="sms-form" className="btn btn--ink" data-save-sms>
                Save
              </button>
            </>
          ) : (
            <Link href="/dashboard/settings/connections/sms?edit=1" className="btn btn--ink" data-change-sms>
              Change
            </Link>
          )
        }
      />

      {q.saved === "1" && !editing && (
        <p className="note note--info" role="status">
          Saved.
        </p>
      )}

      {editing ? (
        <KeptForm action={saveSmsAction} id="sms-form" className="sms-form">
          <Registration sender={s.sender} switchedOn={s.switchedOn} editing />
          <Messages templates={s.templates} editing />
        </KeptForm>
      ) : (
        <>
          <Registration sender={s.sender} switchedOn={s.switchedOn} editing={false} />
          <Messages templates={s.templates} editing={false} />
        </>
      )}
    </>
  );
}

function Registration({
  sender,
  switchedOn,
  editing,
}: {
  sender: { entityId: string; header: string } | null;
  switchedOn: boolean;
  editing: boolean;
}) {
  return (
    <section className="card wa-card" aria-labelledby="sms-reg">
      <div className="card__head">
        <h2 id="sms-reg">DLT registration</h2>
        <span className={`pill pill--${switchedOn ? "ok" : "quiet"}`}>
          <span className="pill__dot" />
          {switchedOn ? "SMS sending on" : "SMS sending not switched on yet"}
        </span>
      </div>
      <div className="sms-reg">
        <label className="sms-reg__field">
          <span className="formfield__label">Entity id</span>
          {editing ? (
            <input
              name="entityId"
              className="formfield__input tnum"
              inputMode="numeric"
              defaultValue={sender?.entityId ?? ""}
              placeholder="19 digits, e.g. 1201159178483176795"
              required
              data-entity-id
            />
          ) : (
            <strong className="tnum">{sender?.entityId}</strong>
          )}
        </label>
        <label className="sms-reg__field">
          <span className="formfield__label">Header</span>
          {editing ? (
            <input
              name="header"
              className="formfield__input sms-header"
              defaultValue={sender?.header ?? ""}
              placeholder="Six letters, e.g. SATHHT"
              maxLength={8}
              autoCapitalize="characters"
              required
              data-header
            />
          ) : (
            <strong>{sender?.header}</strong>
          )}
        </label>
      </div>
    </section>
  );
}

function Messages({ templates, editing }: { templates: SmsTemplateView[]; editing: boolean }) {
  return (
    <section className="card wa-card" aria-labelledby="sms-msgs">
      <div className="card__head">
        <h2 id="sms-msgs">Messages</h2>
        <span className="pill pill--quiet">Register each word for word</span>
      </div>
      {/* Lays itself out as rows on a phone (sms.css). */}
      <table className="wa-msgs sms-msgs" data-keep>
        <thead>
          <tr>
            <th scope="col">Message</th>
            <th scope="col">Words to register</th>
            <th scope="col">DLT template id</th>
          </tr>
        </thead>
        <tbody>
          {templates.map((t) => (
            <tr key={`${t.purpose}|${t.voice}`} data-sms-template={`${t.purpose}_${t.voice}`} data-state={t.state}>
              <td>
                <span className="wa-msgs__label">{t.label}</span>
                <span className="wa-msgs__why">{VOICE_WORDS[t.voice]}</span>
              </td>
              <td>
                <code className="sms-words">{t.body}</code>
              </td>
              <td className="sms-id">
                {editing ? (
                  <input
                    name={`t_${t.purpose}_${t.voice}`}
                    className="formfield__input tnum"
                    inputMode="numeric"
                    defaultValue={t.state === "SENDS" ? (t.templateId ?? "") : ""}
                    placeholder="19 digits"
                    aria-label={`DLT template id, ${t.label}, ${VOICE_WORDS[t.voice]}`}
                  />
                ) : (
                  <>
                    <span className={`pill pill--${TONE[t.state]}`}>{SMS_STATE_WORDS[t.state]}</span>
                    {t.templateId && t.state === "SENDS" && <small className="tnum">{t.templateId}</small>}
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
