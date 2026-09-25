import { Suspense } from "react";
import { clientLoader } from "./-docs-loader";

export function DocsPage({ path }: { path: string }) {
  return <Suspense>{clientLoader.useContent(path)}</Suspense>;
}
