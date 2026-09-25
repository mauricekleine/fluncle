import { WarningIcon } from "@phosphor-icons/react";
import { type ReactNode } from "react";

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

export function AccountDisclosure({ children, summary }: { children: ReactNode; summary: string }) {
  return (
    <details className="account-details account-kit-disclosure">
      <summary className="account-details-summary">{summary}</summary>
      {children}
    </details>
  );
}

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
