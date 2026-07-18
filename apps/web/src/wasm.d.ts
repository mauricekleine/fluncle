// Static .wasm imports compile into the Worker bundle as WebAssembly modules (the Cloudflare
// vite build; workers-og carries its own wasm the same way). This ambient declaration types
// them for tsc, which otherwise has no module shape for the extension.
declare module "*.wasm" {
  const wasmModule: WebAssembly.Module;
  export default wasmModule;
}
