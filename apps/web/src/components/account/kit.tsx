// THE ACCOUNT KIT — the Fence Ladder (DESIGN.md; the account redesign brief §Fence
// Ladder). Enclosure encodes consequence: how many sides a concern prints says how
// much its boundary matters.
//
//   - Class A · AccountSection  — a frequent concern (Profile, Preferences). A
//     two-sided crop bracket (border-top + border-left in a stardust mix, rounded
//     top-left), a stamped header (a Phosphor mark + a bold sentence-case label), an
//     optional helper line, the body, then an optional action rule dividing status
//     (left) from the Save (right). The Save is outline at rest and IGNITES to gold
//     only when the section is dirty — stacked sections can never show two suns.
//   - Class B · AccountRow      — a set-once concern (Email, Key notation). One
//     divider rule, label left / control right, an optional helper. The control is
//     the save.
//   - Class C · AccountDisclosure — a rare concern (Link the CLI). Zero chrome, it
//     folds. Reuses the existing `.account-details` pattern.
//   - Class D · AccountFence    — danger (Export & deletion). Four sides, a red-keyed
//     border, always open, a Warning-icon header. A destructive act is never behind a
//     disclosure; a disclosure is never boxed.
//
// The CSS lives beside the existing `account-*` block in styles.css, derived only
// from existing tokens (--dust-line, --stardust, --destructive, --eclipse-gold).

import { WarningIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";

/**
 * Class A. Pass `onSubmit` to render the section as a `<form>` (so the Save is a real
 * submit and Enter works); omit it for a plain informational section. The action rule
 * renders only when `action` or `status` is present.
 */
export function AccountSection({
  action,
  children,
  helper,
  icon,
  label,
  onSubmit,
  status,
}: {
  action?: ReactNode;
  children: ReactNode;
  helper?: ReactNode;
  icon: ReactNode;
  label: string;
  onSubmit?: (event: React.FormEvent) => void;
  status?: ReactNode;
}) {
  const content = (
    <>
      <div className="account-kit-header">
        <span aria-hidden className="account-kit-mark">
          {icon}
        </span>
        <span className="account-kit-label">{label}</span>
      </div>
      {helper ? <p className="account-kit-helper">{helper}</p> : null}
      <div className="account-kit-body">{children}</div>
      {action || status ? (
        <div className="account-kit-action">
          <div className="account-kit-status">{status}</div>
          <div className="account-kit-action-control">{action}</div>
        </div>
      ) : null}
    </>
  );

  return onSubmit ? (
    <form className="account-kit-section" onSubmit={onSubmit}>
      {content}
    </form>
  ) : (
    <section className="account-kit-section">{content}</section>
  );
}

/** Class B. One divider rule; the label reads left, the control (which IS the save) reads right. */
export function AccountRow({
  control,
  helper,
  label,
}: {
  control: ReactNode;
  helper?: ReactNode;
  label: ReactNode;
}) {
  return (
    <div className="account-kit-row">
      <div className="account-kit-row-main">
        <span className="account-kit-row-label">{label}</span>
        <div className="account-kit-row-control">{control}</div>
      </div>
      {helper ? <p className="account-kit-helper">{helper}</p> : null}
    </div>
  );
}

/** Class C. A receded disclosure — zero sides, it folds. */
export function AccountDisclosure({ children, summary }: { children: ReactNode; summary: string }) {
  return (
    <details className="account-details account-kit-disclosure">
      <summary className="account-details-summary">{summary}</summary>
      {children}
    </details>
  );
}

/** Class D. The fence — four sides, red-keyed, always open, a Warning-icon header. */
export function AccountFence({ children, label }: { children: ReactNode; label: string }) {
  return (
    <section className="account-kit-fence">
      <div className="account-kit-fence-header">
        <WarningIcon aria-hidden weight="bold" />
        <span className="account-kit-label">{label}</span>
      </div>
      {children}
    </section>
  );
}
