"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useFormStatus } from "react-dom";
import { addUnitTypeAction, type UnitFormState } from "@/app/actions/unit";
import { useKeptSubmit } from "@/components/KeptForm";

type Config = { key: string; label: string; plot?: boolean };

/**
 * Record what this tower sells.
 *
 * A configuration is set once and never edited into a different one: a 2 BHK
 * that becomes a 3 BHK is a different product, not a correction, and an edit
 * path for it would leave an approval attached to something nobody approved.
 * So there is no configuration picker on an existing row, only here.
 *
 * It returns rather than redirects, like the upload beside it, so the list
 * re-renders in place and the page does not blink.
 */
export default function UnitPanel({
  nodeId,
  configs,
  basePsf,
}: {
  nodeId: string;
  configs: Config[];
  basePsf: number | null;
}) {
  const [state, action] = useActionState<UnitFormState, FormData>(addUnitTypeAction, null);
  // A refusal keeps what was typed, so "2 BHK is already recorded" can be
  // fixed by changing the variant rather than typing the areas again. Only a
  // configuration that landed empties the form for the next one.
  const onSubmit = useKeptSubmit(action);
  const form = useRef<HTMLFormElement>(null);
  // A plot is sold by its plot area and has no carpet; a villa or a row house
  // may record the plot it stands on as well. A flat shows neither.
  const [config, setConfig] = useState("");
  const isPlot = config === "PLOT";
  const takesPlot = !!configs.find((c) => c.key === config)?.plot;

  useEffect(() => {
    if (state?.ok) {
      form.current?.reset();
      setConfig("");
    }
  }, [state]);

  return (
    <form action={action} onSubmit={onSubmit} ref={form}>
      <input type="hidden" name="nodeId" value={nodeId} />

      <div className="uploader__row">
        <label className="uploader__field">
          <span>Configuration</span>
          <select name="config" required defaultValue="" onChange={(e) => setConfig(e.target.value)}>
            <option value="" disabled>
              Choose
            </option>
            {configs.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </label>

        <label className="uploader__field">
          <span>Variant</span>
          <input type="text" name="variant" maxLength={40} placeholder="Optima" />
        </label>

        {!isPlot && (
          <label className="uploader__field">
            <span>Carpet area, sq ft</span>
            <input
              type="text"
              name="carpetAreaSqft"
              required
              inputMode="decimal"
              placeholder="682"
              data-carpet
            />
          </label>
        )}

        {takesPlot && (
          <>
            <label className="uploader__field">
              <span>{isPlot ? "Plot area" : "Plot area (optional)"}</span>
              <input
                type="text"
                name="plotArea"
                required={isPlot}
                inputMode="decimal"
                placeholder="200"
                data-plot
              />
            </label>
            <label className="uploader__field">
              <span>Measured in</span>
              <select name="areaUnit" defaultValue="SQYD">
                <option value="SQFT">sq ft</option>
                <option value="SQYD">sq yd</option>
                <option value="SQM">sq m</option>
              </select>
            </label>
          </>
        )}

        {takesPlot && !isPlot && (
          <label className="uploader__field">
            <span>Rate is per sq ft of</span>
            <select name="priceBasis" defaultValue="CARPET">
              <option value="CARPET">Carpet area</option>
              <option value="PLOT">Plot area</option>
            </select>
          </label>
        )}

        {!isPlot && (
          <label className="uploader__field">
            <span>Balcony, sq ft</span>
            <input type="text" name="balconyAreaSqft" inputMode="decimal" placeholder="58" />
          </label>
        )}

        <label className="uploader__field">
          <span>Starting price</span>
          <input
            type="text"
            name="startingPrice"
            inputMode="numeric"
            // Empty, the price is the carpet area times the signed rate, and
            // the ghost text is that rate. Leaving the box alone is the
            // ordinary case, so the box says what leaving it alone does.
            placeholder={basePsf ? `Rs ${basePsf.toLocaleString("en-IN")} a sq ft` : "76,30,000"}
            data-price
          />
        </label>
      </div>

      <Submit state={state} />
    </form>
  );
}

function Submit({ state }: { state: UnitFormState }) {
  const { pending } = useFormStatus();
  return (
    <div className="uploader__go">
      <button type="submit" className="btn btn--ink" disabled={pending} data-add-unit>
        {pending ? "Recording" : "Record configuration"}
      </button>
      {state && (
        <span
          className={state.ok ? "uploader__said" : "uploader__said uploader__said--bad"}
          role="status"
          data-unit-result
        >
          {state.message}
        </span>
      )}
    </div>
  );
}
