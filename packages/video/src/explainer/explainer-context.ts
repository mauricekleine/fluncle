// Cross-cutting render flags for the Explainer, provided at the composition root
// so deeply-nested surfaces (the mock panels) can read them without prop drilling.

import { createContext } from "react";

export type ExplainerFlags = {
  /** Burn the "screen capture → …" hint onto placeholder surfaces. Off by default
   *  so the output is clean; flip on for a capture-planning render. */
  showCaptureHints: boolean;
};

export const ExplainerContext = createContext<ExplainerFlags>({ showCaptureHints: false });
