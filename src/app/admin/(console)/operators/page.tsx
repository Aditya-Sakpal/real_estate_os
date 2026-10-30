import { PageHead } from "@/components/shell/PageHead";
import { operatorEmails, requireOperator } from "@/lib/operator";
import { CardHead } from "../kit";

export default async function AdminOperators() {
  const me = await requireOperator();
  const list = operatorEmails();
  return (
    <>
      <PageHead
        title={
          <>
            Who can <span className="em">sign in</span>
          </>
        }
        meta="Sales Desk staff only. Each signs in with a link emailed to them, good for 15 minutes, and stays signed in for 12 hours."
      />
      <section className="adm-two">
        <div className="card">
          <CardHead title="Operators" sub={`${list.length} addresses`} />
          <ul className="adm-list">
            {list.map((e) => (
              <li key={e}>
                <span className="adm-avatar" aria-hidden>
                  {e.slice(0, 1).toUpperCase()}
                </span>
                <span className="adm-list__main">
                  <strong>{e}</strong>
                  <small>{e === me ? "You" : "Operator"}</small>
                </span>
                {e === me && <span className="pill pill--ok">Signed in</span>}
              </li>
            ))}
          </ul>
        </div>
        <div className="card">
          <CardHead title="Adding or removing someone" />
          <p className="adm-copy">
            The list is the <code>OPERATOR_EMAILS</code> setting on Vercel. Change it there and redeploy. Somebody taken off the list is signed out on their next page.
          </p>
          <p className="adm-copy">
            Sign-in emails come from our Amazon email account, which is still in its test mode: only addresses verified there receive the link.
          </p>
        </div>
      </section>
    </>
  );
}
