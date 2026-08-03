import { ChevronDown, Ellipsis, ExternalLink, GithubIcon, Globe, Trash2 } from 'lucide-react';
import { observer } from 'mobx-react-lite';
import { ProjectWorkModeSwitcher } from '@renderer/features/projects/components/project-work-mode-switcher';
import { useConfirmDeleteProject } from '@renderer/features/projects/hooks/use-confirm-delete-project';
import {
  asMounted,
  getProjectStore,
  getGitRepositoryStore,
  projectDisplayName,
  projectViewKind,
} from '@renderer/features/projects/stores/project-selectors';
import { OpenInMenu } from '@renderer/lib/components/titlebar/open-in-menu';
import { Titlebar } from '@renderer/lib/components/titlebar/Titlebar';
import { rpc } from '@renderer/lib/ipc';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { Separator } from '@renderer/lib/ui/separator';
import { isGitHubDotComHost, parseRepositoryRef } from '@shared/repository-ref';

const MountedProjectTitlebarLeft = observer(function ProjectTitlebarLeft({
  projectId,
}: {
  projectId: string;
}) {
  const { navigate } = useNavigate();
  const store = getProjectStore(projectId);
  const displayName = projectDisplayName(store) ?? 'this project';
  const confirmDeleteProject = useConfirmDeleteProject();

  const repo = getGitRepositoryStore(projectId);
  const baseRemote = repo?.baseRemote;
  const remoteUrl = baseRemote?.url;
  const repositoryUrl = repo?.canonicalRepositoryUrl;
  const repository = parseRepositoryRef(repositoryUrl);

  const isGithubUrl = repository ? isGitHubDotComHost(repository.host) : false;
  const repoLabel = repository?.nameWithOwner ?? remoteUrl?.replace(/^https?:\/\//, '');

  return (
    <div className="flex h-full items-center gap-2 px-2">
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button className="group flex items-center gap-1.5 text-sm text-foreground-muted hover:text-foreground">
              <span className="text-sm">{displayName}</span>
              <ChevronDown className="size-3.5" />
            </button>
          }
        >
          <Ellipsis className="size-4" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="min-w-40">
          <DropdownMenuItem
            className="flex items-center gap-2 text-foreground-destructive"
            onClick={() => {
              void confirmDeleteProject({
                projectId,
                projectLabel: displayName,
                onDeleted: () => navigate('home'),
              });
            }}
          >
            <Trash2 className="size-4" />
            Remove Project
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <Separator orientation="vertical" className="h-4 data-[orientation=vertical]:self-center" />
      <ProjectWorkModeSwitcher projectId={projectId} />
      {remoteUrl && (
        <>
          <Separator
            orientation="vertical"
            className="h-4 data-[orientation=vertical]:self-center"
          />
          <Button
            variant="ghost"
            className="group flex items-center gap-1.5 text-sm text-foreground-muted transition-colors hover:text-foreground"
            onClick={() =>
              void rpc.app.openExternal(
                isGithubUrl ? (repository?.repositoryUrl ?? remoteUrl ?? '') : (remoteUrl ?? '')
              )
            }
          >
            <div className="flex items-center gap-1 text-sm">
              {isGithubUrl ? <GithubIcon className="size-3.5" /> : <Globe className="size-3.5" />}
              <span className="truncate">{repoLabel}</span>
            </div>
            <ExternalLink className="size-3.5 shrink-0 text-foreground-muted opacity-0 transition-opacity group-hover:opacity-100 hover:text-foreground" />
          </Button>
        </>
      )}
    </div>
  );
});

const ProjectTitlebarLeft = observer(function ProjectTitlebarLeft({
  projectId,
}: {
  projectId: string;
}) {
  const store = getProjectStore(projectId);
  const displayName = projectDisplayName(store);
  return (
    <div className="flex items-center gap-2 px-2">
      <span className="text-sm text-foreground-muted">{displayName}</span>
    </div>
  );
});

/**
 * Shared titlebar content for a project's workspace, used by both the
 * `project` view (List/Pull Requests/Settings) and the `board` view
 * (ticket #44) so the work-mode switcher above is reachable regardless of
 * which canonical view is mounted -- there is otherwise no way back to List
 * or Pull Requests once the full-width board view leaves `project`'s own
 * navigation out of view.
 */
const ProjectWorkspaceTitlebar = observer(function ProjectWorkspaceTitlebar({
  projectId,
}: {
  projectId: string;
}) {
  const store = getProjectStore(projectId);
  const kind = projectViewKind(store);

  if (kind !== 'ready') {
    return <Titlebar leftSlot={<ProjectTitlebarLeft projectId={projectId} />} />;
  }

  const mounted = asMounted(store);
  if (!mounted) return <Titlebar leftSlot={<ProjectTitlebarLeft projectId={projectId} />} />;

  return (
    <Titlebar
      leftSlot={<MountedProjectTitlebarLeft projectId={projectId} />}
      rightSlot={
        <div className="mr-2 flex items-center gap-2">
          <OpenInMenu
            path={mounted.data.path}
            className="h-7 bg-background"
            isRemote={mounted.data.type === 'ssh'}
            sshConnectionId={mounted.data.type === 'ssh' ? mounted.data.connectionId : undefined}
          />
        </div>
      }
    />
  );
});

export const ProjectTitlebar = observer(function ProjectTitlebar() {
  const {
    params: { projectId },
  } = useParams('project');
  return <ProjectWorkspaceTitlebar projectId={projectId} />;
});

/** Board view's titlebar slot (ticket #44) -- see `ProjectWorkspaceTitlebar`. */
export const BoardTitlebar = observer(function BoardTitlebar() {
  const {
    params: { projectId },
  } = useParams('board');
  return <ProjectWorkspaceTitlebar projectId={projectId} />;
});
