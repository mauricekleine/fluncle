import { type ComponentType, lazy, type LazyExoticComponent } from "react";

type LazyNamedComponent<TComponent> =
  TComponent extends ComponentType<infer TProps>
    ? LazyExoticComponent<ComponentType<TProps>>
    : never;

export function lazyNamed<TModule, TKey extends keyof TModule>(
  load: () => Promise<TModule | undefined>,
  name: TKey,
): LazyNamedComponent<TModule[TKey]> {
  return lazy(async () => {
    const loaded = await load();

    if (!loaded) {
      throw new Error(`Failed to fetch dynamically imported module for ${String(name)}`);
    }

    return { default: loaded[name] as ComponentType<unknown> };
  }) as LazyNamedComponent<TModule[TKey]>;
}
