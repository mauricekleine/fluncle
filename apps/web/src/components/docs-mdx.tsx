import defaultMdxComponents from "fumadocs-ui/mdx";

// The component map every docs MDX body renders with. Fumadocs' defaults cover
// headings (with anchors), code blocks, callouts, cards, and links — its <a>
// already routes internal hrefs through the framework provider set up by the
// docs layout's RootProvider, so in-docs navigation stays client-side.
export function getDocsMdxComponents() {
  return {
    ...defaultMdxComponents,
  };
}
