import type { ReactNode } from 'react';
import { ProjectSshHealthGate } from './project-ssh-health-gate';

interface ProjectViewWrapperProps {
  children: ReactNode;
  projectId: string;
  /**
   * Optional focused-task identifier (ticket #50): the task titlebar's
   * Workflow Stage chip navigates back to the `board` view carrying the
   * originating task's id so `BoardMainPanel` can resolve, scroll to,
   * highlight, and open the inspector for it. Declared here (shared by both
   * `project` and `board`, which both use this as their `WrapView`) rather
   * than on a board-only wrapper because `WrapParams<'board'>`
   * (`view-registry.ts`) derives directly from this component's own props —
   * the `project` view simply never receives or reads it.
   */
  focusTaskId?: string;
}

export function ProjectViewWrapper({ children, projectId }: ProjectViewWrapperProps) {
  return <ProjectSshHealthGate projectId={projectId}>{children}</ProjectSshHealthGate>;
}
