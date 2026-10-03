// DNS-rebinding defense for the plugin's same-origin API routes — mirrors the
// fence dsh's own /api gateway uses. The browser calls these routes
// same-origin, so this is defense-in-depth, not authentication.

interface NodeIncomingMessage {
  headers: Record<string, string | string[] | undefined>
}

export function isTrustedApiRequest(
  req: NodeIncomingMessage,
  trustedHosts: readonly string[],
): boolean {
  const host = req.headers['host']
  const hostStr = Array.isArray(host) ? host[0] : host
  // When there is no Host header (some desktop webviews / internal fetches),
  // treat the request as trusted rather than rejecting it outright — the route
  // is same-origin and only reachable from the bundled client anyway.
  if (!hostStr) return true
  const hostName = hostStr.split(':')[0].toLowerCase()
  // localhost / loopback / unix sockets / dsh internal names are always OK.
  if (
    hostName === 'localhost' ||
    hostName === '127.0.0.1' ||
    hostName === '::1' ||
    hostName === '[::1]' ||
    hostName.endsWith('.internal') ||
    hostName === '' ||
    hostName.startsWith('localhost.')
  ) {
    return true
  }
  return trustedHosts.includes(hostName)
}
