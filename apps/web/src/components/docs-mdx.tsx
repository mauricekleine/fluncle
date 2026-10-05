import { buttonVariants } from "fumadocs-ui/components/ui/button";
import defaultMdxComponents from "fumadocs-ui/mdx";
import { useCopyButton } from "fumadocs-ui/utils/use-copy-button";
import { CopyCheckIcon, LinkIcon } from "lucide-react";
import { type ComponentProps } from "react";
import { cn } from "@/lib/utils";

type HeadingLevel = "h1" | "h2" | "h3" | "h4" | "h5" | "h6";

function DocsHeading({ as: As, ...props }: ComponentProps<HeadingLevel> & { as: HeadingLevel }) {
  const [isChecked, onCopy] = useCopyButton(() => {
    if (!props.id) {
      return;
    }
    const url = new URL(window.location.href);
    url.hash = props.id;
    return navigator.clipboard.writeText(url.href);
  });

  if (!props.id) {
    return <As {...props} />;
  }

  return (
    <div className="docs-heading group/heading relative w-fit max-w-full pr-7">
      <As {...props} className={cn("scroll-m-28", props.className)}>
        <a data-card="" href={`#${props.id}`}>
          {props.children}
        </a>
      </As>
      <button
        type="button"
        aria-label={isChecked ? "Link copied" : "Copy link to this section"}
        aria-live="polite"
        className={cn(
          buttonVariants({ size: "icon-xs", variant: "ghost" }),
          "not-prose absolute top-1/2 right-0 shrink-0 -translate-y-1/2 text-fd-muted-foreground opacity-0 transition-opacity group-hover/heading:opacity-100 focus-visible:opacity-100",
        )}
        onClick={onCopy}
      >
        {isChecked ? <CopyCheckIcon aria-hidden="true" /> : <LinkIcon aria-hidden="true" />}
      </button>
    </div>
  );
}

export function getDocsMdxComponents() {
  return {
    ...defaultMdxComponents,
    h1: (props: ComponentProps<"h1">) => <DocsHeading as="h1" {...props} />,
    h2: (props: ComponentProps<"h2">) => <DocsHeading as="h2" {...props} />,
    h3: (props: ComponentProps<"h3">) => <DocsHeading as="h3" {...props} />,
    h4: (props: ComponentProps<"h4">) => <DocsHeading as="h4" {...props} />,
    h5: (props: ComponentProps<"h5">) => <DocsHeading as="h5" {...props} />,
    h6: (props: ComponentProps<"h6">) => <DocsHeading as="h6" {...props} />,
  };
}
