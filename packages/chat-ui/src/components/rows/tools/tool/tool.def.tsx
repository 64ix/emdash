import { ROW_H } from '@components/engine/row-metrics';
import { defineUnit } from '@core/units';
import type { ChatToolCall } from '@/model';
import { Tool, toolUnitH, type ToolVars } from './Tool';

export { toolFromItem } from './tool-presentation';

const TOOL_VARS: ToolVars = {
  rowH: ROW_H,
  border: 1,
  paramRowH: 22,
  resourceRowH: ROW_H,
  actionsRowH: 32,
  detailLineH: 18,
  detailMaxLines: 16,
  linePadX: 12,
};

export const toolUnitDef = defineUnit<ChatToolCall, ToolVars>({
  kind: 'tool',
  margin: { top: 2, bottom: 2 },
  vars: TOOL_VARS,
  // The expanded inspector body (normalized params, bounded result/error text,
  // resources) reads poorly compressed into the prose column — declare the
  // wider artifact lane (ticket #27). The layout resolves this to an exact
  // width; toolUnitH/Tool never branch on width themselves.
  lane: 'artifact',

  estimate(_data, _ctx, vars): number {
    return vars.rowH;
  },

  measure(item, ctx, vars): number {
    return toolUnitH(item, ctx, vars);
  },

  Render(props) {
    return <Tool item={props.data} ctx={props.ctx} vars={props.vars} />;
  },
});
