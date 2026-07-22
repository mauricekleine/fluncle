/// <reference types="@cloudflare/workers-types" />
// Ambient binding types for the spike Worker. `@cloudflare/workers-types`
// declares the global `Cloudflare.Env` INTERFACE and the `Vectorize` class; we
// declaration-MERGE our two bindings + the optional token into it, so `env` (from
// `cloudflare:workers`) is typed. This file is a script (no imports/exports) so
// the augmentation stays global. `interface` is required here — declaration
// merging does not work with a `type` alias — hence the lint exception.

declare namespace Cloudflare {
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Env {
    SPIKE_TRACKS: Vectorize;
    SPIKE_CENTROIDS: Vectorize;
    SPIKE_TOKEN?: string;
  }
}
