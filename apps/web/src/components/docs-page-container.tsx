import { useDocsPage } from "fumadocs-ui/layouts/docs/page";
import { type ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function DocsPageContainer(props: ComponentProps<"article">) {
  const { full } = useDocsPage();

  return (
    <main
      data-full={full}
      id="nd-page"
      {...props}
      className={cn(
        "flex flex-col w-full max-w-[900px] mx-auto [grid-area:main] px-4 py-6 gap-4 md:px-6 md:pt-8 xl:px-8 xl:pt-14",
        full && "max-w-[1168px]",
        props.className,
      )}
    />
  );
}
