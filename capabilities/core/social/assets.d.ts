// Workers bundles .bin files as data and .wasm files as compiled modules (wrangler's default rules).
declare module '*.bin' {
  const data: ArrayBuffer
  export default data
}
declare module '*.wasm' {
  const module: WebAssembly.Module
  export default module
}
