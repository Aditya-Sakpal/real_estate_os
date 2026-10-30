"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** While a document is being read, look again every few seconds; stop when none is. */
export default function ReadingPoll({ active }: { active: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [active, router]);
  return null;
}
