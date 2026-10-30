import Link from "next/link";
import { redirect } from "next/navigation";
import { getViewer } from "@/lib/console";
import { overview } from "@/lib/billing";
import { PLAN_KEYS, plansFor, type AgentJob, type PlanKey } from "@/lib/billing-rules";
import {
  AGENT_CARDS,
  VOICE_CARDS,
  VOICE_PLAN,
  sampleFor,
  unlockPlan,
  voiceIn,
  voiceOpen,
  type AgentCard,
  type VoiceKey,
} from "@/lib/agent-catalog";
import { pickedVoices, readyVoices } from "@/lib/agent-voices";
import { PageHead } from "@/components/shell/PageHead";
import { ArrowUpRight, Chat, Check, Lock, Phone } from "@/components/icons";
import { Listen } from "./Listen";
import { VoicePicker, type VoiceOption } from "./VoicePicker";
import "./agents.css";

/**
 * The AI team, per project. Every agent is shown, in the order a buyer meets
 * them, with when it acts, what it does and the voice it speaks in, picked
 * here from the voices the project's plan opens. Agents and voices the plan
 * does not open are shown locked, naming the plan that opens them, and a
 * locked voice is never played. Beside it, the voices and the plans.
 *
 * An organisation with no plan sold is never refused on account of billing,
 * so every agent and voice is open there.
 */

const rupees = (paise: number) => `Rs ${Math.round(paise / 100).toLocaleString("en-IN")}`;

export default async function AgentsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  const orgId = viewer.state.org.id;
  // A channel partner's plans are its own (Solo, Team, Firm), priced per firm.
  const PLANS = plansFor(viewer.orgType === "CHANNEL_PARTNER" ? "ORG" : "PROJECT");
  const [o, params] = await Promise.all([overview(orgId), searchParams]);

  const reach = new Set(viewer.state.projects.map((p) => p.id));
  const projects = o.projects.filter((p) => reach.has(p.id));
  const asked = typeof params.project === "string" ? params.project : null;
  const project = projects.find((p) => p.id === asked) ?? projects.find((p) => p.sub) ?? projects[0] ?? null;
  const picked = project ? await pickedVoices(orgId, project.id) : {};
  const ready = readyVoices();
  const projectPath = project ? viewer.state.projects.find((p) => p.id === project.id)?.path ?? null : null;
  const canEdit = !!projectPath && viewer.authz.canAt("org:manage", projectPath);

  const billed = !!o.mode;
  const plan: PlanKey | null = billed ? project?.sub?.plan ?? null : null;
  const included = new Set<AgentJob>(billed ? project?.sub?.agents ?? [] : AGENT_CARDS.map((a) => a.job));
  const working = AGENT_CARDS.filter((a) => included.has(a.job)).length;
  const open = (v: VoiceKey) => voiceOpen(v, plan, billed);

  const meta = !project
    ? "Add a project to put agents to work."
    : !billed
      ? `${project.name}: all six agents and every voice are open.`
      : plan
        ? `${project.name} is on ${PLANS[plan].label}: ${working} of 6 agents work its leads.`
        : `${project.name} has no plan yet, so no agent works its leads.`;

  /** The voice choice for one agent: every voice, the ones it cannot take shown and disabled. */
  const optionsFor = (a: AgentCard, agentOn: boolean): VoiceOption[] =>
    VOICE_CARDS.map((v) => {
      const locked = !open(v.key)
        ? PLANS[VOICE_PLAN[v.key]].label
        : !agentOn
          ? "Locked"
          : !(ready[a.job]?.has(v.key) ?? v.key === a.voice)
            ? "Not ready"
            : null;
      return { key: v.key, name: v.name, recommended: !!v.recommended, locked, sample: open(v.key) ? sampleFor(a, v.key) : null };
    });
  const spoken = (a: AgentCard): VoiceKey | null => {
    const v = voiceIn(a, picked);
    return v && open(v) ? v : a.voice;
  };
  const usedBy = (key: VoiceKey) => AGENT_CARDS.filter((a) => a.voice && spoken(a) === key).map((a) => a.name);

  const [lead, ...rest] = AGENT_CARDS;

  return (
    <div className="agt">
      <PageHead title={<>Your AI <span className="em">team</span></>} meta={meta} />

      {projects.length > 1 && (
        <nav className="agt-projects" aria-label="Project">
          {projects.map((p) => {
            const on = p.id === project?.id;
            return (
              <Link
                key={p.id}
                href={`/dashboard/agents?project=${p.id}`}
                className={`agt-chip${on ? " is-on" : ""}`}
                aria-current={on ? "page" : undefined}
                scroll={false}
              >
                {p.name}
                {billed && <span className="agt-chip__plan">{p.sub ? p.sub.label : "No plan"}</span>}
              </Link>
            );
          })}
        </nav>
      )}

      <div className="agt-grid">
        <div className="agt-main">
          <AgentFeature
            agent={lead}
            on={included.has(lead.job)}
            projectId={project?.id ?? null}
            canEdit={canEdit}
            voice={spoken(lead)}
            options={optionsFor(lead, included.has(lead.job))}
            unlockLabel={PLANS[unlockPlan(lead.job)].label}
          />

          <section className="card agt-list" aria-label="More agents">
            <ol>
              {rest.map((a) => {
                const on = included.has(a.job);
                const voice = spoken(a);
                const name = VOICE_CARDS.find((v) => v.key === voice)?.name;
                const options = optionsFor(a, on);
                const sample = voice && open(voice) ? sampleFor(a, voice) : null;
                return (
                  <li key={a.job} className={`agt-row${on ? "" : " is-locked"}`} data-agent={a.job}>
                    <span className={`agt-avatar agt-avatar--${voice ?? "chat"}`} aria-hidden>
                      {a.channel === "whatsapp" ? <Chat size={18} /> : <Phone size={18} />}
                      {!on && (
                        <span className="agt-avatar__lock">
                          <Lock size={11} />
                        </span>
                      )}
                    </span>
                    <div className="agt-row__body">
                      <div className="agt-row__top">
                        <h3>{a.name}</h3>
                        {on ? (
                          <span className="pill pill--ok">
                            <span className="pill__dot" />
                            Included
                          </span>
                        ) : (
                          <span className="pill agt-lockpill">
                            <Lock size={11} />
                            Unlocks on {PLANS[unlockPlan(a.job)].label}
                          </span>
                        )}
                      </div>
                      <p className="agt-row__when">{a.when}</p>
                      <p className="agt-row__does">{a.does}</p>
                      <p className="agt-row__line">
                        <span className="agt-row__said">{a.channel === "whatsapp" ? "On WhatsApp" : `${name ?? "It"} says`}</span>
                        {a.line}
                      </p>
                    </div>
                    <div className="agt-row__side">
                      {a.channel === "whatsapp" ? (
                        <span className="agt-row__chan">
                          <Chat size={13} />
                          WhatsApp
                        </span>
                      ) : a.choosable && voice ? (
                        <VoicePicker key={`${project?.id}:${a.job}`} projectId={project?.id ?? null} job={a.job} agent={a.name} options={options} value={voice} canEdit={canEdit && on} />
                      ) : (
                        <div className="agt-pick">
                          <div className="agt-pick__row">
                            <span className="agt-pick__fixed">{name}</span>
                            {sample ? (
                              <Listen src={sample} label={a.name} />
                            ) : (
                              <span className="agt-pick__locked" aria-label="Locked voice">
                                <Lock size={12} />
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        </div>

        <aside className="agt-rail">
          <section className="card agt-voices" aria-labelledby="agt-voices-h">
            <div className="card__head">
              <h2 id="agt-voices-h">Voices</h2>
              {billed && plan && <span className="pill pill--quiet">{PLANS[plan].label}</span>}
            </div>
            <ul>
              {VOICE_CARDS.map((v) => {
                const isOpen = open(v.key);
                const agents = usedBy(v.key);
                return (
                  <li key={v.key} className={`agt-voice${v.recommended ? " is-reco" : ""}${isOpen ? "" : " is-locked"}`}>
                    <span className={`agt-avatar agt-avatar--sm agt-avatar--${isOpen ? v.key : "off"}`} aria-hidden>
                      {v.name[0]}
                    </span>
                    <div className="agt-voice__body">
                      <div className="agt-voice__top">
                        <strong>{v.name}</strong>
                        {v.recommended && <span className="pill pill--blue">Recommended</span>}
                      </div>
                      <span className="agt-voice__sound">{v.sound}</span>
                      {isOpen && agents.length > 0 && <span className="agt-voice__used">Speaks for {agents.join(", ")}</span>}
                    </div>
                    {isOpen ? (
                      <Listen src={v.sample} label={`the ${v.name} voice`} />
                    ) : (
                      <span className="pill agt-lockpill">
                        <Lock size={11} />
                        {PLANS[VOICE_PLAN[v.key]].label}
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {/* The developer's plans are its own business, never a mandate firm's working through it. */}
          {!viewer.via && (
          <section className="card agt-plans" aria-labelledby="agt-plans-h">
            <div className="card__head">
              <h2 id="agt-plans-h">Plans</h2>
              {billed && viewer.authz.can("billing:read") && (
                <Link href="/dashboard/settings/billing" className="agt-plans__link">
                  Plan and usage
                  <ArrowUpRight size={13} />
                </Link>
              )}
            </div>
            {/* A comparison, so on a phone it stays a grid rather than a list of cards. */}
            <table data-keep="">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">What it carries</span>
                  </th>
                  {PLAN_KEYS.map((k) => (
                    <th key={k} scope="col" className={k === plan ? "is-yours" : undefined}>
                      <span className="agt-plans__name">{PLANS[k].label}</span>
                      <span className="agt-plans__price">{rupees(PLANS[k].pricePaise)}</span>
                      {k === plan && <span className="agt-plans__yours">Yours</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {AGENT_CARDS.map((a) => (
                  <tr key={a.job}>
                    <th scope="row">{a.name}</th>
                    {PLAN_KEYS.map((k) => (
                      <td key={k} className={k === plan ? "is-yours" : undefined}>
                        <Mark yes={PLANS[k].agents.includes(a.job)} />
                      </td>
                    ))}
                  </tr>
                ))}
                <tr className="agt-plans__group">
                  <th scope="row">Voices</th>
                  {PLAN_KEYS.map((k) => (
                    <td key={k} className={k === plan ? "is-yours" : undefined}>
                      {VOICE_CARDS.filter((v) => voiceOpen(v.key, k, true)).length}
                    </td>
                  ))}
                </tr>
                {VOICE_CARDS.map((v) => (
                  <tr key={v.key}>
                    <th scope="row" className="agt-plans__sub">
                      {v.name}
                    </th>
                    {PLAN_KEYS.map((k) => (
                      <td key={k} className={k === plan ? "is-yours" : undefined}>
                        <Mark yes={voiceOpen(v.key, k, true)} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="agt-plans__note">A month per project, before GST.</p>
          </section>
          )}
        </aside>
      </div>
    </div>
  );
}

function Mark({ yes }: { yes: boolean }) {
  return yes ? (
    <span className="agt-plans__yes" aria-label="Included">
      <Check size={12} />
    </span>
  ) : (
    <span className="agt-plans__no" aria-label="Not included" />
  );
}

/** The agent every plan carries, as the one dark card. */
function AgentFeature({
  agent,
  on,
  projectId,
  canEdit,
  voice,
  options,
  unlockLabel,
}: {
  unlockLabel: string;
  agent: AgentCard;
  on: boolean;
  projectId: string | null;
  canEdit: boolean;
  voice: VoiceKey | null;
  options: VoiceOption[];
}) {
  return (
    <section className={`agt-feature${on ? "" : " is-locked"}`} data-agent={agent.job}>
      <div className="agt-feature__head">
        <div className="agt-feature__id">
          <span className={`agt-avatar agt-avatar--lg agt-avatar--${voice ?? "advait"}`} aria-hidden>
            <Phone size={22} />
          </span>
          <div>
            <div className="agt-feature__top">
              <h2>{agent.name}</h2>
              {on ? (
                <span className="agt-feature__pill">
                  <span className="pill__dot" />
                  Working
                </span>
              ) : (
                <span className="agt-feature__pill is-locked">
                  <Lock size={11} />
                  Unlocks on {unlockLabel}
                </span>
              )}
            </div>
            <p className="agt-feature__when">{agent.when}</p>
          </div>
        </div>
        {voice && <VoicePicker key={`${projectId}:${agent.job}`} projectId={projectId} job={agent.job} agent={agent.name} options={options} value={voice} canEdit={canEdit && on} tone="dark" />}
      </div>
      <p className="agt-feature__does">{agent.does}</p>
      <div className="agt-feature__say">
        <p>{agent.line}</p>
      </div>
    </section>
  );
}
