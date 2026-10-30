/**
 * The status page Meta's data deletion callback points at. Public, because
 * the person asking is on Facebook, not signed in here. The deletion itself
 * happened before the callback answered, so there is nothing pending to show.
 *
 * It says the data was deleted only when it arrives with a code shaped like
 * the ones the callback issues (twelve base64url characters). Anybody else
 * who lands here, with no code or a made-up one, is told how to remove the
 * app instead, rather than being told something happened that did not.
 */
const CODE = /^[A-Za-z0-9_-]{12}$/;

export default async function DeletionStatus({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const { code } = await searchParams;
  const reference = typeof code === "string" && CODE.test(code) ? code : null;
  return (
    <main style={{ maxWidth: 520, margin: "12vh auto", padding: "0 20px" }}>
      <section className="card">
        {reference ? (
          <>
            <h1 style={{ fontSize: 22 }}>Your Facebook data has been deleted</h1>
            <p className="sub" style={{ marginTop: 10 }}>
              Sales Desk no longer holds the access you granted through Facebook, or your Facebook id.
            </p>
            <p className="sub" style={{ marginTop: 10 }}>
              Reference: <strong>{reference}</strong>
            </p>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: 22 }}>Remove Sales Desk from Facebook</h1>
            <p className="sub" style={{ marginTop: 10 }}>
              To remove Sales Desk, open Facebook settings, Apps and websites, and remove it.
            </p>
          </>
        )}
      </section>
    </main>
  );
}
