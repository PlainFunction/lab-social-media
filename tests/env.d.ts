declare namespace Cloudflare {
  interface Env {
    KV: KVNamespace
    DB: D1Database
  }
}

declare module '*?raw' {
  const text: string
  export default text
}
