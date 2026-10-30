"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  useActionState,
} from "react";
import { saveBrandAction, type BrandState } from "@/app/actions/brand";
import { useKeptSubmit } from "@/components/KeptForm";
import { Check } from "@/components/icons";

/**
 * The editing screen, held together by one piece of state.
 *
 * Two things sit far apart in the page and have to agree: the Save control is
 * up in the header and the fields are down the page, and the header cannot be
 * inside the form without being inside the card it belongs beside. So the
 * whole screen is wrapped in this and they read the same context: whether
 * anything has been touched, whether a save is in flight, and how the last one
 * went.
 *
 * `useActionState` returns rather than redirects, so saving updates the page
 * in place instead of navigating to the same URL and blinking.
 */
type Editing = {
  action: (formData: FormData) => void;
  state: BrandState;
  pending: boolean;
  touched: boolean;
  touch: () => void;
  formId: string;
};

const Ctx = createContext<Editing | null>(null);

function useEditing(): Editing {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("Branding control used outside the editor");
  return ctx;
}

export function BrandEditor({
  formId,
  children,
}: {
  formId: string;
  children: React.ReactNode;
}) {
  const [state, action, pending] = useActionState<BrandState, FormData>(
    saveBrandAction,
    null,
  );
  const [touched, setTouched] = useState(false);
  const touch = useCallback(() => setTouched(true), []);

  // A save that landed leaves nothing to save. The chosen files go with it:
  // a picker still holding last time's file would upload it again the next
  // time somebody corrects a phone number, and say so in the message. A
  // refusal empties nothing: what was typed and chosen stays for the fix.
  // The pickers sit outside the form element and join it by attribute, so
  // they are found through `elements`, not among its descendants.
  useEffect(() => {
    if (!state?.ok) return;
    setTouched(false);
    const form = document.getElementById(formId) as HTMLFormElement | null;
    Array.from(form?.elements ?? []).forEach((el) => {
      if (el instanceof HTMLInputElement && el.type === "file") el.value = "";
    });
  }, [state, formId]);

  return (
    <Ctx.Provider value={{ action, state, pending, touched, touch, formId }}>
      {children}
    </Ctx.Provider>
  );
}

/**
 * The form itself.
 *
 * Every text field is inside it, and the four file pickers up in the Marks
 * card join it through the `form` attribute, so one press saves everything
 * that was filled in. Touching anything is what brings the Save control into
 * existence, and `input` plus `change` between them cover a typed character
 * and a ticked box; a picker reports its own choice (`MarkPicker`).
 *
 * It submits through `useKeptSubmit`, because React empties a form after
 * every action, refused or not, and a refusal that also wiped the colours
 * and the logos somebody had just chosen is a refusal nobody can act on.
 */
export function BrandFields({
  nodeId,
  children,
}: {
  nodeId: string;
  children: React.ReactNode;
}) {
  const { action, touch, formId } = useEditing();
  const onSubmit = useKeptSubmit(action);
  return (
    <form action={action} onSubmit={onSubmit} id={formId} onInput={touch} onChange={touch}>
      <input type="hidden" name="nodeId" value={nodeId} />
      {children}
    </form>
  );
}

/**
 * One mark's file picker.
 *
 * The Marks card sits outside the form element so that each mark's Remove
 * can carry its own confirmation (a form inside a form is dropped by the
 * browser). The picker still belongs to the one form by attribute, and says
 * so itself when a file is chosen, since its `change` no longer bubbles
 * through the form.
 */
/**
 * Smart transparency badge for an existing uploaded mark.
 */
export function MarkStatusBadge({
  src,
  role,
}: {
  src: string;
  role: string;
}) {
  const [status, setStatus] = useState<"transparent" | "opaque" | "loading">("loading");

  useEffect(() => {
    if (role === "TYPEFACE") return;
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        const scale = Math.min(1, 100 / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, w, h);
        const { data } = ctx.getImageData(0, 0, w, h);
        let transparentPx = 0;
        const totalPx = w * h;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] < 240) transparentPx++;
        }
        setStatus(transparentPx / totalPx >= 0.01 ? "transparent" : "opaque");
      } catch {
        setStatus("transparent");
      }
    };
    img.onerror = () => setStatus("loading");
    img.src = src;
  }, [src, role]);

  if (status === "loading" || role === "TYPEFACE") return null;

  if (status === "opaque") {
    return (
      <span className="brandfile__tag brandfile__tag--warn" title="Solid background detected">
        ⚠️ Solid background
      </span>
    );
  }

  return (
    <span className="brandfile__tag brandfile__tag--good" title="Transparent background verified">
      ✓ Transparent
    </span>
  );
}

/**
 * One mark's file picker with intelligent background transparency detection.
 *
 * The Marks card sits outside the form element so that each mark's Remove
 * can carry its own confirmation (a form inside a form is dropped by the
 * browser). The picker still belongs to the one form by attribute, and says
 * so itself when a file is chosen, since its `change` no longer bubbles
 * through the form.
 */
export function MarkPicker({
  name,
  accept,
  role,
  label,
}: {
  name: string;
  accept: string;
  role: string;
  label: string;
}) {
  const { touch, formId, state } = useEditing();
  const [analysis, setAnalysis] = useState<{
    file: File;
    previewUrl: string;
    isOpaque: boolean;
    solidColor?: string;
    hasTransparency: boolean;
  } | null>(null);

  useEffect(() => {
    if (state?.ok) {
      setAnalysis(null);
    }
  }, [state?.ok]);

  useEffect(() => {
    return () => {
      if (analysis?.previewUrl) URL.revokeObjectURL(analysis.previewUrl);
    };
  }, [analysis?.previewUrl]);

  const onChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      touch();
      const file = e.target.files?.[0];
      if (!file) {
        setAnalysis(null);
        return;
      }

      if (role === "TYPEFACE") {
        setAnalysis(null);
        return;
      }

      const previewUrl = URL.createObjectURL(file);

      // Fast detection for JPEGs (never have alpha transparency)
      if (file.type === "image/jpeg" || /\.(jpe?g)$/i.test(file.name)) {
        setAnalysis({
          file,
          previewUrl,
          isOpaque: true,
          solidColor: "opaque",
          hasTransparency: false,
        });
        return;
      }

      // Live alpha analysis for PNG / WebP
      const img = new Image();
      img.onload = () => {
        try {
          const canvas = document.createElement("canvas");
          const scale = Math.min(1, 128 / Math.max(img.width, img.height));
          const w = Math.max(1, Math.round(img.width * scale));
          const h = Math.max(1, Math.round(img.height * scale));
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext("2d", { willReadFrequently: true });
          if (!ctx) {
            setAnalysis({ file, previewUrl, isOpaque: false, hasTransparency: true });
            return;
          }
          ctx.drawImage(img, 0, 0, w, h);
          const { data } = ctx.getImageData(0, 0, w, h);
          let transparentPx = 0;
          const totalPx = w * h;
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] < 240) transparentPx++;
          }
          const hasTransparency = transparentPx / totalPx >= 0.01;
          const isWhite = data[0] > 220 && data[1] > 220 && data[2] > 220;
          const isDark = data[0] < 40 && data[1] < 40 && data[2] < 40;
          const solidColor = isWhite ? "white" : isDark ? "dark" : "opaque";

          setAnalysis({
            file,
            previewUrl,
            isOpaque: !hasTransparency,
            solidColor,
            hasTransparency,
          });
        } catch {
          setAnalysis({ file, previewUrl, isOpaque: false, hasTransparency: true });
        }
      };
      img.onerror = () => {
        setAnalysis({ file, previewUrl, isOpaque: false, hasTransparency: true });
      };
      img.src = previewUrl;
    },
    [touch, role],
  );

  return (
    <div className="brandfile__pickwrap">
      <label className="brandfile__pick">
        <span className="brandfile__picklabel">{label}</span>
        <input
          type="file"
          form={formId}
          name={name}
          accept={accept}
          className="refupload__file"
          data-pick={role}
          onChange={onChange}
        />
      </label>

      {analysis && (
        <div className="brandfile__picked">
          {analysis.previewUrl && (
            <div className="brandfile__pickedpreview" title="Live preview on transparent checkerboard">
              <img src={analysis.previewUrl} alt="Selected mark preview" />
            </div>
          )}

          {analysis.isOpaque ? (
            <div className="brandfile__alert brandfile__alert--warn" role="alert">
              <span className="brandfile__alerticon" aria-hidden>⚠️</span>
              <div className="brandfile__alertbody">
                <strong>Solid background detected</strong>
                <span>
                  This logo has a solid {analysis.solidColor} background. For clean ad designs without a box, please upload a logo with a transparent background (PNG).
                </span>
              </div>
            </div>
          ) : analysis.hasTransparency ? (
            <div className="brandfile__alert brandfile__alert--good" role="status">
              <span className="brandfile__alerticon" aria-hidden>✓</span>
              <div className="brandfile__alertbody">
                <strong>Transparent background verified</strong>
                <span>Logo has transparent background and will place cleanly on ads.</span>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Save, and only when there is something to save.
 *
 * An untouched form has nothing to write, so the button is not rendered at
 * all: a control that does nothing should not exist. After a save it says so
 * and stays saying so until the next edit, because a button still reading
 * "Save branding" is the screen's only answer to "did that work", and it is
 * the wrong one.
 */
export function BrandSave() {
  const { state, pending, touched, formId } = useEditing();

  if (pending) {
    return (
      <button type="button" className="btn btn--ink" disabled data-saving>
        Saving
      </button>
    );
  }

  if (!touched) {
    if (!state?.ok) return null;
    return (
      <span className="savedmark" role="status" data-saved>
        <Check size={14} />
        Saved
      </span>
    );
  }

  return (
    <button type="submit" form={formId} className="btn btn--ink" data-save>
      Save branding
      <Check size={14} />
    </button>
  );
}

/**
 * What happened, when it is more than the header already said.
 *
 * The header carries "Saved", so repeating it here is furniture. A refusal or
 * a count of uploaded files is not: those name something the person has to
 * read.
 */
export function BrandNote() {
  const { state } = useEditing();
  if (!state) return null;
  if (state.ok && state.message === "Saved.") return null;

  return (
    <div
      className={`note ${state.ok ? "note--info" : "note--risk"}`}
      style={{ marginBottom: 16 }}
      role={state.ok ? "status" : "alert"}
      data-result
    >
      {state.message}
    </div>
  );
}
