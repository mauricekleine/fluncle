import { createContext } from "react";

export type ExplainerFlags = {
  showCaptureHints: boolean;
};

export const ExplainerContext = createContext<ExplainerFlags>({ showCaptureHints: false });
