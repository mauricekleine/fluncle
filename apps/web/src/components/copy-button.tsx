import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

// Outline icon button that copies `text` to the clipboard; the check-mark
// confirmation flashes Eclipse Gold (DESIGN.md's CLI command pattern).
export function CopyButton({
  confirmation,
  label,
  text,
}: {
  /** Screen-reader confirmation, e.g. "Install command copied." */
  confirmation: string;
  /** Accessible button label, e.g. "Copy install command". */
  label: string;
  text: string;
}) {
  const [didCopy, setDidCopy] = useState(false);
  const copyResetTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    return () => clearTimeout(copyResetTimeout.current);
  }, []);

  async function copyText(): Promise<void> {
    await navigator.clipboard.writeText(text);
    setDidCopy(true);
    clearTimeout(copyResetTimeout.current);
    copyResetTimeout.current = setTimeout(() => setDidCopy(false), 2000);
  }

  return (
    <>
      <Button aria-label={label} onClick={copyText} size="icon" variant="outline">
        {didCopy ? (
          <CheckIcon aria-hidden="true" className="text-primary" weight="bold" />
        ) : (
          <CopyIcon aria-hidden="true" weight="bold" />
        )}
      </Button>
      <p aria-live="polite" className="sr-only">
        {didCopy ? confirmation : ""}
      </p>
    </>
  );
}
