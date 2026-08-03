import type { ResourceTarget } from '@/model';

/**
 * Secondary (path/host) label for a resource-link row.
 *
 * `target` is normally pre-resolved by the desktop's enrichment transform
 * before a resource-link item enters chat-ui (see `ResourceTarget` in
 * `model.ts`). A resource-link item decoded directly from real ACP
 * `resource_link` content (spec #18 ticket #21) can legitimately reach this
 * component before that resolution step runs, so `target` is treated as
 * optional here — this is purely a display fallback, never a security
 * decision: clicking a resource-link row always re-classifies the row's raw
 * `uri` through the same fail-closed link-action taxonomy regardless of
 * what `target` says (see `ResourceLink.tsx`'s click handler).
 */
export function secondaryLabel(uri: string, target: ResourceTarget | undefined): string {
  if (target?.kind === 'workspace-file' || target?.kind === 'local-file') {
    return target.path;
  }
  if (target?.kind === 'external') {
    try {
      return new URL(target.url).hostname;
    } catch {
      return target.url;
    }
  }
  // opaque, or a not-yet-resolved target: show the scheme or the raw uri, capped.
  const colon = uri.indexOf(':');
  return colon > 0 ? uri.slice(0, colon + 1) + '//' + '…' : uri;
}
