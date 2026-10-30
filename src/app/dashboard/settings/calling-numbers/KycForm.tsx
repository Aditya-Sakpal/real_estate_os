"use client";

import { useState } from "react";
import { useFormStatus } from "react-dom";
import { ArrowUpRight } from "@/components/icons";
import { BUSINESS_TYPES, needsAadhaar, type BusinessType } from "@/lib/calling-number-rules";

/**
 * Verifying the business on our own screen: how it is registered, then the
 * documents that registration is checked with. A company gives its PAN and
 * its GSTIN or CIN; a person, a proprietor or an HUF gives its PAN here and
 * Aadhaar through DigiLocker, which the button says before it is pressed.
 */
export function KycForm({
  action,
  type,
  email,
}: {
  action: (formData: FormData) => void | Promise<void>;
  type: BusinessType;
  email: string;
}) {
  const [picked, setPicked] = useState<BusinessType>(type);
  const aadhaar = needsAadhaar(picked);
  return (
    <form action={action} className="cn-kyc__form">
      <label className="cn-search__field">
        <span className="formfield__label">Registered as</span>
        <select
          name="businessType"
          className="select-field"
          value={picked}
          onChange={(e) => setPicked(e.target.value as BusinessType)}
          required
        >
          {BUSINESS_TYPES.map((b) => (
            <option key={b.key} value={b.key}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <label className="cn-search__field">
        <span className="formfield__label">{aadhaar ? "PAN" : "Business PAN"}</span>
        <input
          name="pan"
          className="formfield__input tnum cn-kyc__code"
          autoCapitalize="characters"
          placeholder="ABCDE1234F"
          maxLength={10}
          autoComplete="off"
          spellCheck={false}
          required
        />
      </label>
      {!aadhaar && (
        <>
          <label className="cn-search__field">
            <span className="formfield__label">GSTIN</span>
            <input
              name="gstin"
              className="formfield__input tnum cn-kyc__code"
              autoCapitalize="characters"
              placeholder="27ABCDE1234F1Z5"
              maxLength={15}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="cn-search__field">
            <span className="formfield__label">CIN, if no GST</span>
            <input
              name="cin"
              className="formfield__input tnum cn-kyc__code"
              autoCapitalize="characters"
              placeholder="U70100MH2015PTC123456"
              maxLength={21}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </>
      )}
      <label className="cn-search__field">
        <span className="formfield__label">Email</span>
        <input
          name="email"
          type="email"
          className="formfield__input"
          defaultValue={email}
          placeholder="you@company.com"
          maxLength={254}
          required
        />
      </label>
      <Submit aadhaar={aadhaar} />
    </form>
  );
}

function Submit({ aadhaar }: { aadhaar: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="btn btn--ink" disabled={pending} data-verify-business>
      {pending ? "Checking" : aadhaar ? "Verify PAN, then Aadhaar on DigiLocker" : "Verify business"}
      {!pending && <ArrowUpRight size={14} />}
    </button>
  );
}
