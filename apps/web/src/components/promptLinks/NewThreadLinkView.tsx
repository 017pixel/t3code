import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { type NewThreadLink, promptLinkPullRequestUrl } from "@t3tools/shared/promptLinks";
import { useLocation } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { isElectron } from "~/env";

import { usePullRequestHandoffs } from "../pullRequest/usePullRequestActions";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import {
  cloneNewThreadLinkRepository,
  newThreadLinkLocationKey,
  openNewThreadLinkWithoutProject,
  reopenNewThreadLink,
  useNewThreadLinkState,
} from "./openNewThreadLink";

export function NewThreadLinkView({ link }: { readonly link: NewThreadLink }) {
  const locationKey = useLocation({ select: newThreadLinkLocationKey });
  const state = useNewThreadLinkState(locationKey);

  switch (state.status) {
    case "opening":
      return <LinkPage title="Opening the link..." />;
    case "opened":
      return (
        <LinkPage title="This link is open">
          <Button size="sm" variant="outline" onClick={() => reopenNewThreadLink(locationKey)}>
            Open it again
          </Button>
        </LinkPage>
      );
    case "failed":
      return (
        <LinkPage title={state.title ?? "Could not open the link"} description={state.message} />
      );
    case "missing-repository": {
      const name = `${state.repository.owner}/${state.repository.name}`;
      return (
        <LinkPage
          title={`You don't have ${name}`}
          description="Clone it to work on it here, or start without a project."
        >
          <Button
            size="sm"
            onClick={() => cloneNewThreadLinkRepository(locationKey, link, state.repository)}
          >
            Clone {name}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => openNewThreadLinkWithoutProject(locationKey, link)}
          >
            Use without project
          </Button>
        </LinkPage>
      );
    }
    case "pull-request-checkout":
      return link.kind === "pull-request" ? (
        <PullRequestLinkCheckout link={link} project={state.project} />
      ) : null;
  }
}

/** Checkout runs setup from PR code, so links alone must not start it. */
function PullRequestLinkCheckout({
  link,
  project,
}: {
  readonly link: Extract<NewThreadLink, { kind: "pull-request" }>;
  readonly project: EnvironmentProject;
}) {
  const { handoff, startHandoff } = usePullRequestHandoffs({
    environmentId: project.environmentId,
    detail: {
      projectId: project.id,
      workspaceRoot: project.workspaceRoot,
      url: promptLinkPullRequestUrl(link.pullRequest),
    },
  });
  const { owner, name, number } = link.pullRequest;
  return (
    <LinkPage
      title={`Check out ${owner}/${name}#${number}?`}
      description="This puts the pull request's code in a new worktree and runs your project's setup script on it."
    >
      <Button
        size="sm"
        disabled={handoff !== null}
        onClick={() =>
          void startHandoff(
            "prompt-link",
            link.prompt === null ? null : { prompt: link.prompt.text },
          )
        }
      >
        {handoff !== null ? "Checking out..." : "Check out"}
      </Button>
    </LinkPage>
  );
}

function LinkPage({
  title,
  description,
  children,
}: {
  readonly title: string;
  readonly description?: string;
  readonly children?: ReactNode;
}) {
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <EmptyTitle>{title}</EmptyTitle>
          {description ? <EmptyDescription>{description}</EmptyDescription> : null}
          {children ? <div className="mt-5 flex justify-center gap-2">{children}</div> : null}
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
