"use client";

import { useState } from "react";

/**
 * The hook, as a text box with suggestions beside it.
 *
 * It was a plain input with a `<datalist>`, which is free text and always was.
 * Nothing on screen said so: a datalist shows nothing until you start typing,
 * so the field read as a box you were supposed to know the answer to. The
 * chips make both halves visible at once, that these are the usual hooks and
 * that yours can be something else entirely.
 */
export default function HookField({
  name,
  suggestions,
  defaultValue,
}: {
  name: string;
  suggestions: readonly string[];
  defaultValue: string;
}) {
  const [value, setValue] = useState(defaultValue);

  return (
    <div className="hookfield">
      <input
        type="text"
        name={name}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        maxLength={80}
        placeholder="Two minutes from the new metro line"
        className="formfield__input"
      />
      <div className="hookfield__chips">
        {suggestions.map((s) => {
          const chosen = value.trim().toLowerCase() === s.toLowerCase();
          return (
            <button
              key={s}
              type="button"
              className={`hookchip${chosen ? " hookchip--on" : ""}`}
              aria-pressed={chosen}
              // A second click clears it, so a chip picked by accident does
              // not have to be deleted by hand out of the box above.
              onClick={() => setValue(chosen ? "" : s)}
            >
              {s}
            </button>
          );
        })}
      </div>
    </div>
  );
}
