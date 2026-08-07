import type { AcpStartInputWire } from '@emdash/core/acp';
import type { ProviderCustomConfig } from '@shared/core/app-settings';

/**
 * Applies the provider's configured launch defaults to an ACP start input.
 *
 * Explicit values on the input (a model chosen in the launch modal, a resume
 * carrying the session's own selection) always win; defaults only fill the
 * gap when no explicit value is present. The values ride the same start-input
 * path as the in-session selectors' `setSessionConfigOption` and are applied
 * best-effort after session start, so an invalid default keeps the provider's
 * own default and never fails the launch.
 */
export function applyProviderLaunchDefaults(
  input: AcpStartInputWire,
  config: ProviderCustomConfig | undefined
): AcpStartInputWire {
  return {
    ...input,
    model: input.model ?? config?.defaultModel ?? null,
    effort: input.effort ?? config?.defaultEffort ?? null,
  };
}
