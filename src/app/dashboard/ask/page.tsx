import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LAST_CHAT_COOKIE, lastChatId } from "@/lib/ask-last-chat";
import { getViewer } from "@/lib/console";
import { listThreads, loadThread, questionsLeft, startersForViewer } from "@/lib/ask";
import { ACTIONS, actionsOn, mayOffer } from "@/lib/ask-actions";
import { maySetUp } from "@/lib/setup";
import { MAX_QUESTION_CHARS, throughMandate } from "@/lib/ask-rules";
import { AskJimmy } from "./AskJimmy";
import "./ask.css";

/**
 * Ask Jimmy: questions about your own data, answered from it.
 *
 * Open to every member, and to a firm's people in a developer's console
 * through a mandate, where Jimmy reads only the mandated projects, leaves out
 * the developer's partners, payouts and spend, and uses the firm's own
 * questions. The page reads only the viewer's own chats; what
 * Jimmy may tell them is decided per question from the keys they hold, so
 * there is no permission to check here beyond being a member at all.
 *
 * `?t=` names the chat on screen. Without it, the chat this person last had
 * open in this browser session (`ask-last-chat.ts`), so coming back to Ask
 * Jimmy from another screen carries on where they were. An id that is not
 * theirs reads as a new chat rather than an error: a stale tab after a
 * delete should just start over.
 */
export default async function AskPage({ searchParams }: { searchParams: Promise<{ t?: string }> }) {
  const viewer = await getViewer();
  if (!viewer) redirect("/");
  const { t } = await searchParams;
  const orgId = viewer.state.org.id;
  const open = t ?? lastChatId((await cookies()).get(LAST_CHAT_COOKIE)?.value);

  const [threads, thread, left, acting] = await Promise.all([
    listThreads(orgId, viewer.userId),
    open ? loadThread(orgId, viewer.userId, open) : Promise.resolve(null),
    // Through a mandate, the firm's own questions are used, never the developer's.
    questionsLeft(viewer.via?.firmOrgId ?? orgId, viewer.userId),
    actionsOn(orgId),
  ]);
  const offered = acting ? ACTIONS.filter((a) => mayOffer(a, viewer.authz)).map((a) => a.kind) : [];
  const { starters: asked } = startersForViewer(viewer.via ? throughMandate(viewer.authz) : viewer.authz, viewer.orgType);
  // One thing to ask Jimmy to do, beside the questions, when there is something this person may do.
  const doing =
    offered.includes("call_lead") ? "Call my hottest lead" :
    offered.includes("make_post") ? "Make a post for a campaign" :
    offered.includes("visit_update") ? "Check in a buyer who has arrived" :
    offered.includes("approve_post") ? "Approve the next post waiting for review" :
    null;
  const starters = doing ? [...asked.slice(0, 5), doing] : asked;
  const first = (viewer.name ?? "").trim().split(/\s+/)[0] || null;

  return (
    <AskJimmy
      // A fresh key on every render of a new chat, so deleting a chat or
      // following "New chat" from a server redirect starts from a clean slate.
      key={thread?.id ?? `new-${Date.now()}`}
      firstName={first}
      threads={threads}
      thread={thread}
      starters={starters}
      left={left}
      canAct={offered.length > 0}
      // Files set a project up, or add to one: only for someone who may do either, in their own console.
      canAttach={acting && !viewer.via && maySetUp(viewer.authz)}
      maxChars={MAX_QUESTION_CHARS}
    />
  );
}
