import { type SVGProps } from "react";

/** The shape simple-icons exports per glyph (we only read these two fields). */
type SimpleIcon = { readonly title: string; readonly path: string };

/**
 * Renders a simple-icons brand glyph at the current text color. Pass a `title`
 * to expose an accessible name; without one the icon is decorative (the link or
 * button around it carries the label, as in the home plate's social row).
 */
export function BrandIcon({
  icon,
  title,
  ...props
}: { icon: SimpleIcon; title?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      fill="currentColor"
      role="img"
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      {title ? <title>{title}</title> : null}
      <path d={icon.path} />
    </svg>
  );
}
