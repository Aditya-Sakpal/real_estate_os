"use client";

import { useState } from "react";

type Option = { value: string; label: string };

/**
 * The three choices for one role. "Then sees" means something only once a
 * stage is picked, so it is disabled until one is, rather than offered and
 * ignored.
 */
export function PolicyFields({
  role,
  visibilities,
  stages,
  before,
  from,
  after,
}: {
  role: string;
  visibilities: Option[];
  stages: Option[];
  before: string;
  from: string;
  after: string;
}) {
  const [stage, setStage] = useState(from);
  return (
    <div className="pn-form">
      <div className="field">
        <label htmlFor={`pn-before-${role}`}>Sees</label>
        <select id={`pn-before-${role}`} name="before" className="select-field" defaultValue={before}>
          {visibilities.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`pn-from-${role}`}>Changes from</label>
        <select
          id={`pn-from-${role}`}
          name="from"
          className="select-field"
          value={stage}
          onChange={(e) => setStage(e.target.value)}
        >
          <option value="">Never</option>
          {stages.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor={`pn-after-${role}`}>Then sees</label>
        <select
          id={`pn-after-${role}`}
          name="after"
          className="select-field"
          defaultValue={after}
          disabled={!stage}
        >
          {visibilities.map((v) => (
            <option key={v.value} value={v.value}>
              {v.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
