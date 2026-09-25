import { type SVGProps } from "react";

type SimpleIcon = { readonly title: string; readonly path: string };

export function BrandIcon({
  icon,
  title,
  ...props
}: { icon: SimpleIcon; title?: string } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden={title ? undefined : true}
      fill="currentColor"
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an inline <svg> carries role="img" by convention; swapping to <img> would need an external asset.
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
