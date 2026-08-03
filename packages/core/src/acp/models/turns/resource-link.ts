import { z } from 'zod';

/**
 * A resource-link row — produced by an ACP `resource_link` content block
 * inside a `user_message_chunk` / `agent_message_chunk` notification.
 *
 * This is a standalone transcript item (a sibling of `message`/`thinking`),
 * never a child of a tool call. It mirrors the ACP `ResourceLink` schema
 * fields verbatim (uri/name/title/description/mimeType/size) — no path
 * resolution or trust decision happens here. Core stays transport-agnostic;
 * the desktop host resolves `uri` into a display/addressing target and
 * attaches it before the item reaches the chat renderer.
 */
export const transcriptResourceLinkSchema = z.object({
  kind: z.literal('resource-link'),
  /** Stable item id, scoped to the owning turn. */
  id: z.string(),
  /** Stable order within the owning turn, assigned once by the reducer. */
  seq: z.number().int(),
  /** Original ACP URI, preserved verbatim for display, copy, and resolution. */
  uri: z.string(),
  /** Required resource name (ACP `ResourceLink.name`). */
  name: z.string(),
  /** Optional human-friendly display title. */
  title: z.string().optional(),
  /** Optional one-line description. */
  description: z.string().optional(),
  /** MIME type hint, when the provider supplies one. */
  mimeType: z.string().optional(),
  /** Resource size in bytes, when known. */
  size: z.number().int().optional(),
});
export type TranscriptResourceLink = z.infer<typeof transcriptResourceLinkSchema>;
