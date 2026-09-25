import { Component, type ReactNode } from "react";
import { isStaleBuildError, recoverFromStaleBuild } from "@/lib/stale-build-recovery";

type LazyPopupBoundaryProps = { children: ReactNode };

type LazyPopupBoundaryState = { failed: boolean };

export class LazyPopupBoundary extends Component<LazyPopupBoundaryProps, LazyPopupBoundaryState> {
  override state: LazyPopupBoundaryState = { failed: false };

  static getDerivedStateFromError(): LazyPopupBoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    if (isStaleBuildError(error)) {
      recoverFromStaleBuild();
    }
  }

  override render(): ReactNode {
    return this.state.failed ? null : this.props.children;
  }
}
