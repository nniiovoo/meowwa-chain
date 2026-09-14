const kubernetesDnsLabel = '[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?';
const kubernetesServiceHostname = new RegExp(
  `^${kubernetesDnsLabel}\\.${kubernetesDnsLabel}\\.svc\\.cluster\\.local$`,
);

export function isPinnedKubernetesHttpService(
  url: URL,
  expected: { port: number; pathname?: string },
): boolean {
  return url.protocol === 'http:' &&
    url.port === String(expected.port) &&
    (expected.pathname === undefined || url.pathname === expected.pathname) &&
    kubernetesServiceHostname.test(url.hostname);
}
