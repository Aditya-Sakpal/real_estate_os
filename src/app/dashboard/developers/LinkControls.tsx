"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "@/components/icons";
import { makeLinkAction } from "@/app/workspace/actions";

/** Make the firm's link for a tower, the first time it is wanted. */
export function MakeLink({ devOrgId, towerId }: { devOrgId: string; towerId: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [note, setNote] = useState<string | null>(null);
  return (
    <span className="fw-link">
      <button
        type="button"
        className="btn btn--ink btn--sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await makeLinkAction({ devOrgId, towerId });
            if (res.ok) router.refresh();
            else setNote(res.message);
          })
        }
      >
        {pending ? "Making" : "Make my link"}
      </button>
      {note && (
        <span className="fw-buyer__line" role="alert">
          {note}
        </span>
      )}
    </span>
  );
}

/** Copy a link to share, and say so. */
export function CopyLink({ url }: { url: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn btn--ghost btn--sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          window.prompt("Copy the link", url);
        }
      }}
    >
      {copied ? (
        <>
          <Check size={12} /> Copied
        </>
      ) : (
        "Copy link"
      )}
    </button>
  );
}
