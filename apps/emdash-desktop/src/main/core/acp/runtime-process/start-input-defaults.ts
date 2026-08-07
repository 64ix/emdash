import type { AcpStartInputWire } from '@emdash/core/acp';
import type { ProviderCustomConfig } from '@shared/core/app-settings';

/**
 * Applies the provider's configured launch defaults to an ACP start input.
 *
 * Explicit values on the input (a model chosen in the launch modal) always
 * win; defaults only fill the gap when no explicit value is present. Defaults
 * apply to NEW sessions only: an input carrying a `sessionId` resumes an
 * existing session, whose own in-session model/effort selections must be
 * preserved, so it is returned untouched (explicit values still flow). The
 * values ride the same start-input path as the in-session selectors'
 * `setSessionConfigOption` and are applied best-effort after session start,
 * so an invalid default keeps the provider's own default and never fails the
 * launch.
 */
export function applyProviderLaunchDefaults(
  input: AcpStartInputWire,
  config: ProviderCustomConfig | undefined
): AcpStartInputWire {
  if (input.sessionId) return input;
  return {
    ...input,
    model: input.model ?? config?.defaultModel ?? null,
    effort: input.effort ?? config?.defaultEffort ?? null,
  };
}
