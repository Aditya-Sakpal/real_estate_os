import Link from "next/link";
import type { AlwaysOnView } from "@/lib/publish";
import { showRupees } from "@/lib/connect-rules";
import { endAlwaysOnAction, startAlwaysOnAction } from "@/app/actions/publish";
import { ConfirmAction } from "@/components/ConfirmAction";
import { ArrowUpRight } from "@/components/icons";

/**
 * The campaign's two Google campaigns that run until stopped: Search, which
 * answers what buyers type, and Performance Max, which shows the campaign's
 * pictures across Google. Neither belongs on a calendar, so each is one
 * campaign per brief, started here and switched on from Published.
 *
 * What it will say is shown before it is started, read-only: the words are
 * the campaign's cleared cards and signed facts, nothing typed here.
 */
export function AlwaysOnPanel({
  briefId,
  items,
  mayStart,
  mayStop,
  website,
}: {
  briefId: string;
  items: AlwaysOnView[];
  mayStart: boolean;
  mayStop: boolean;
  website: string | null;
}) {
  const back = `/dashboard/campaigns/brief/${briefId}/schedule`;
  return (
    <section className="card" style={{ marginTop: 16 }} data-always-on>
      <div className="card__head">
        <h2>
          Always <span className="em">on</span>
        </h2>
        <span className="pill pill--quiet">Google</span>
      </div>
      <div className="alwayson">
        {items.map((a) => {
          const live = a.current && a.current.state !== "FAILED" ? a.current : null;
          const failed = a.current?.state === "FAILED" ? a.current : null;
          return (
            <article key={a.destination} className="alwayson__item" data-campaign={a.destination}>
              <header className="alwayson__head">
                <div>
                  <strong>{a.label}</strong>
                  <small>
                    {a.destination === "GOOGLE_SEARCH_AD"
                      ? "Shown when buyers search for the project, its locality or what it sells"
                      : "Your pictures and words across Search, YouTube, Discover, Gmail and Maps"}
                  </small>
                </div>
                {live ? (
                  <span className={`pill pill--${live.state === "ACTIVE" ? "blue" : "quiet"}`} data-state={live.state}>
                    {live.stateLabel}
                  </span>
                ) : (
                  <span className="pill pill--quiet">Not running</span>
                )}
              </header>

              {a.preview && !live && (
                <dl className="alwayson__preview">
                  <div>
                    <dt>Headlines</dt>
                    <dd>{a.preview.headlines.slice(0, 6).join(" · ")}{a.preview.headlines.length > 6 ? ` · and ${a.preview.headlines.length - 6} more` : ""}</dd>
                  </div>
                  <div>
                    <dt>Descriptions</dt>
                    <dd>
                      <ul className="alwayson__lines">
                        {a.preview.descriptions.map((d) => (
                          <li key={d}>{d}</li>
                        ))}
                      </ul>
                    </dd>
                  </div>
                  {a.preview.keywords.length > 0 && (
                    <div>
                      <dt>Searches</dt>
                      <dd>{a.preview.keywords.slice(0, 8).join(", ")}{a.preview.keywords.length > 8 ? `, and ${a.preview.keywords.length - 8} more` : ""}</dd>
                    </div>
                  )}
                  {a.preview.pictures > 0 && (
                    <div>
                      <dt>Pictures</dt>
                      <dd>{a.preview.pictures} from this campaign&apos;s passed posts</dd>
                    </div>
                  )}
                  <div>
                    <dt>Lead form</dt>
                    <dd>{a.preview.leadForm ? "Yes, under the ad" : "No. Add your privacy policy link in Library, Branding"}</dd>
                  </div>
                </dl>
              )}

              {live ? (
                <div className="alwayson__live">
                  <span className="alwayson__meta">
                    {live.dailyBudget ? `${showRupees(live.dailyBudget)} a day` : null}
                    {live.accountName ? ` · ${live.accountName}` : null}
                  </span>
                  {live.note && <p className="alwayson__note">{live.note}</p>}
                  <div className="alwayson__acts">
                    <Link href="/dashboard/campaigns/live" className="btn btn--ghost btn--sm">
                      Open Published
                      <ArrowUpRight size={12} />
                    </Link>
                    {mayStop && (
                      <ConfirmAction
                        label="End it"
                        title={`End the ${a.label}?`}
                        body={<p>It stops spending and no longer runs. A new one can be started from today&apos;s facts.</p>}
                        confirmLabel="End the campaign"
                        action={endAlwaysOnAction}
                        fields={{ targetId: live.id, back }}
                        tone="risk"
                        testId={`end-${a.destination}`}
                      />
                    )}
                  </div>
                </div>
              ) : a.reason ? (
                <p className="alwayson__why" data-why>
                  {a.reason}
                </p>
              ) : mayStart ? (
                <form action={startAlwaysOnAction} className="alwayson__start">
                  <input type="hidden" name="briefId" value={briefId} />
                  <input type="hidden" name="destination" value={a.destination} />
                  <label className="adplan__field">
                    <span>Budget a day</span>
                    <span className="adplan__unit">
                      <span aria-hidden>Rs</span>
                      <input
                        type="text"
                        name="dailyBudget"
                        inputMode="numeric"
                        required
                        placeholder={a.dailyCap ? `Up to ${a.dailyCap.toLocaleString("en-IN")}` : "1,000"}
                        className="formfield__input"
                      />
                    </span>
                  </label>
                  <label className="adplan__field">
                    <span>Landing page</span>
                    <input
                      type="url"
                      name="destinationUrl"
                      inputMode="url"
                      defaultValue={website ?? ""}
                      placeholder="https://yourproject.com"
                      className="formfield__input"
                    />
                  </label>
                  <button type="submit" className="btn btn--ink btn--sm" data-start-campaign={a.destination}>
                    Create a paused {a.label}
                    <ArrowUpRight size={12} />
                  </button>
                </form>
              ) : (
                <p className="alwayson__why">Somebody who can publish here starts it.</p>
              )}

              {failed && !live && <p className="alwayson__why alwayson__why--risk">Last try failed: {failed.error ?? "it could not be created."}</p>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
