import { Link2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { useState } from 'react';
import { LocalDirectorySelector } from '@renderer/features/projects/components/add-project-modal/local-directory-selector';
import { SshConnectionSelector } from '@renderer/features/projects/components/add-project-modal/ssh-connection-selector';
import {
  getProjectManagerStore,
  getProjectStore,
} from '@renderer/features/projects/stores/project-selectors';
import { useShowModal, type BaseModalProps } from '@renderer/lib/modal/modal-provider';
import { appState } from '@renderer/lib/stores/app-state';
import { Button } from '@renderer/lib/ui/button';
import { ConfirmButton } from '@renderer/lib/ui/confirm-button';
import {
  DialogContentArea,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/lib/ui/dialog';
import { Field, FieldLabel } from '@renderer/lib/ui/field';
import { ModalLayout } from '@renderer/lib/ui/modal-layout';
import type { AttachProjectError } from '@shared/projects';

export interface AttachProjectModalProps {
  projectId: string;
  /** Preselect a directory (used when re-opening from within the modal). */
  initialPath?: string;
  /** Preselect a connection (used when re-opening from within the modal). */
  initialConnectionId?: string;
}

type AmbiguityCandidate = { projectId: string; name: string; type: 'local' | 'ssh' };

/**
 * Attach an unattached (synced) project on this machine (spec #130, ticket
 * #136). Local projects pick a directory; SSH projects pick a connection
 * (the remote path travels). When the picked repository matches BOTH a local
 * and an SSH project, the user chooses which one to merge into.
 */
export const AttachProjectModal = observer(function AttachProjectModal({
  projectId,
  initialPath,
  initialConnectionId,
  onSuccess,
  onClose,
}: AttachProjectModalProps & BaseModalProps<void>) {
  const store = getProjectStore(projectId);
  const project = store?.data;
  const isSsh = project?.type === 'ssh';

  const [path, setPath] = useState(initialPath ?? '');
  const [connectionId, setConnectionId] = useState(initialConnectionId ?? '');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ambiguity, setAmbiguity] = useState<AmbiguityCandidate[] | null>(null);

  const showSshConnModal = useShowModal('addSshConnModal');
  const showAttachModal = useShowModal('attachProjectModal');

  const handleAddConnection = () => {
    showSshConnModal({
      onSuccess: (result: unknown) => {
        const newId = (result as { connectionId: string }).connectionId;
        showAttachModal({ projectId, initialConnectionId: newId });
      },
      onClose: () => {
        showAttachModal({ projectId, initialConnectionId: connectionId });
      },
    });
  };

  const handleEditConnection = (id: string) => {
    const conn = appState.sshConnections.connections.find((c) => c.id === id);
    if (!conn) return;
    showSshConnModal({
      initialConfig: conn,
      onSuccess: () => {
        showAttachModal({ projectId, initialConnectionId: connectionId });
      },
      onClose: () => {
        showAttachModal({ projectId, initialConnectionId: connectionId });
      },
    });
  };

  const runAttach = async (mergeTargetProjectId?: string) => {
    if (!project) return;
    setIsSaving(true);
    setError(null);
    try {
      const result = await getProjectManagerStore().attachProject(
        projectId,
        project.type === 'ssh'
          ? { type: 'ssh', projectId, connectionId }
          : { type: 'local', projectId, path, mergeTargetProjectId }
      );
      if (!result.success) {
        if (result.error.type === 'ambiguity') {
          setAmbiguity(result.error.candidates);
          return;
        }
        setError(attachErrorMessage(result.error));
        return;
      }
      onSuccess();
    } finally {
      setIsSaving(false);
    }
  };

  const canSubmit =
    !isSaving && project !== undefined && (isSsh ? connectionId !== '' : path.trim() !== '');

  return (
    <ModalLayout
      header={
        <DialogHeader>
          <DialogTitle>
            {ambiguity !== null ? 'Choose a project to merge into' : 'Attach Project'}
          </DialogTitle>
        </DialogHeader>
      }
      footer={
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSaving}>
            Cancel
          </Button>
          {ambiguity === null && (
            <ConfirmButton onClick={() => void runAttach()} disabled={!canSubmit}>
              {isSaving ? 'Attaching…' : 'Attach'}
            </ConfirmButton>
          )}
        </DialogFooter>
      }
    >
      <DialogContentArea>
        {ambiguity !== null ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-foreground-passive">
              The selected repository is already registered as both a local and an SSH project.
              Merging keeps one entry and moves the synced tasks into it.
            </p>
            {ambiguity.map((candidate) => (
              <button
                key={candidate.projectId}
                type="button"
                className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-left text-sm transition-colors hover:bg-background-quaternary-1"
                onClick={() => void runAttach(candidate.projectId)}
              >
                <Link2 className="size-4 text-foreground-muted" />
                <span className="min-w-0 truncate">{candidate.name}</span>
                <span className="shrink-0 text-xs text-foreground-passive">
                  {candidate.type === 'local' ? 'Local project' : 'SSH project'}
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="text-sm text-foreground-passive">
              {isSsh
                ? 'This project is synced from another machine. Its remote path travels; pick the local SSH connection to use on this machine.'
                : 'This project is synced from another machine and has no local directory here yet. Pick the local clone of the repository to attach it.'}
            </p>
            {isSsh ? (
              <Field>
                <FieldLabel>SSH Connection</FieldLabel>
                <SshConnectionSelector
                  connectionId={connectionId || undefined}
                  onConnectionIdChange={setConnectionId}
                  onAddConnection={handleAddConnection}
                  onEditConnection={handleEditConnection}
                />
              </Field>
            ) : (
              <Field>
                <FieldLabel>Repository Directory</FieldLabel>
                <LocalDirectorySelector
                  title="Attach project"
                  message="Choose the local repository for this project"
                  path={path}
                  onPathChange={setPath}
                />
              </Field>
            )}
            {error !== null && (
              <p className="text-xs text-foreground-destructive" role="alert">
                {error}
              </p>
            )}
          </div>
        )}
      </DialogContentArea>
    </ModalLayout>
  );
});

function attachErrorMessage(error: AttachProjectError): string {
  switch (error.type) {
    case 'already-attached':
      return 'This project is already attached on this machine.';
    case 'invalid-directory':
    case 'inspect-failed':
      return `Could not use this directory: ${error.message}`;
    case 'not-repository':
      return 'The selected directory is not a git repository.';
    case 'remote-mismatch':
      return 'The selected repository does not match this project\u2019s remotes.';
    case 'path-conflict':
      return error.message;
    case 'ssh-connection-not-found':
      return 'The selected SSH connection no longer exists.';
    case 'remote-path-missing':
      return 'This project has no remote path; re-sync it from the machine that created it.';
    case 'merge-target-invalid':
      return 'The chosen merge target is no longer available.';
    case 'project-not-found':
      return 'This project no longer exists.';
    case 'ambiguity':
      return 'Choose which project to merge into.';
  }
}
