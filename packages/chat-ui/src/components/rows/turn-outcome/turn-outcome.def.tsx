/**
 * Turn footer — compact metadata row rendered once after each settled turn
 * (ticket #38, spec #18). Status label + turn-scoped Copy action, plus
 * duration/context/cost only when `state/turn-footer.ts#deriveTurnFooter`
 * genuinely populates them (see that module's doc for why it does not
 * today). No per-row avatars, no timestamps, no continuous animation.
 */

import { ROW_H } from '@components/engine/row-metrics';
import { CopyButton } from '@components/primitives/CopyButton';
import { defineUnit } from '@core/units';
import { formatFooterContext, formatFooterCost, formatFooterDuration } from '@state/turn-footer';
import { Show } from 'solid-js';
import type { TurnOutcomeItem } from '@/model';
import {
  turnFooterMeta,
  turnFooterRoot,
  turnFooterSpacer,
  turnFooterStatus,
} from './turn-outcome.css';

export const turnOutcomeUnitDef = defineUnit<TurnOutcomeItem, { rowH: number }>({
  kind: 'turn-outcome',
  margin: { top: 4, bottom: 4 },
  vars: { rowH: ROW_H },

  // Fixed-height row regardless of content — unlike message/diff/thinking,
  // there is no variable-length text to approximate, so the off-screen
  // estimate can (and must) be exact rather than falling back to
  // `genericEstimate`, which would guess from a non-existent `text`/`name`
  // field and undercount every settled turn's footer in a long transcript
  // (measure/estimate must agree — see this ticket's virtualizer guardrail).
  estimate(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  measure(_data, _ctx, vars_) {
    return vars_.rowH;
  },

  Render(props) {
    const footer = () => props.data.footer;

    return (
      <div class={turnFooterRoot} style={{ height: `${props.vars.rowH}px` }}>
        <span class={turnFooterStatus({ tone: footer().status === 'error' ? 'error' : 'neutral' })}>
          {footer().statusLabel}
        </span>
        <Show when={footer().durationMs}>
          {(duration) => <span class={turnFooterMeta}>{formatFooterDuration(duration())}</span>}
        </Show>
        <Show when={footer().context}>
          {(context) => <span class={turnFooterMeta}>{formatFooterContext(context())}</span>}
        </Show>
        <Show when={footer().cost}>
          {(cost) => <span class={turnFooterMeta}>{formatFooterCost(cost())}</span>}
        </Show>
        <span class={turnFooterSpacer} />
        <CopyButton text={footer().copyText} variant="toolbar" label="Copy turn" />
      </div>
    );
  },
});
