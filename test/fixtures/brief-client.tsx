// Browser-only boundary fixture: render real clients while changing identity in place.
import { createRoot } from "react-dom/client";
import { ProjectBrief } from "../../src/client/ProjectBrief";
import { Projects } from "../../src/client/Projects";
import { BriefAcknowledgements } from "../../src/client/briefView";
import { setViewOwner } from "../../src/client/viewCache";
import { setShellSource } from "../../src/client/sourceRouting";
import type { BriefPage } from "../../src/shared/briefs";

const root = createRoot(document.getElementById("brief-fixture")!);
const noop = () => {};
const empty = () => null;
const receipts = new Map<string, BriefAcknowledgements>();
const state = window as unknown as {
  briefChanges: string[];
  renderBrief: (value: {
    owner: string;
    workspace: string;
    initial: BriefPage;
    parent?: boolean;
  }) => void;
};
state.briefChanges = [];
state.renderBrief = ({ owner, workspace, initial, parent }) => {
  setViewOwner(owner);
  setShellSource(workspace);
  const key = JSON.stringify([owner, workspace, initial.project]);
  if (!receipts.has(key)) receipts.set(key, new BriefAcknowledgements());
  root.render(
    parent ? (
      <Projects
        folders={[
          {
            id: initial.project,
            name: "Isolation project",
            kind: "project",
            parent_id: null,
          },
        ]}
        agents={[]}
        selected={initial.project}
        connections={[]}
        revision={0}
        onSelect={noop}
        onCreate={noop}
        onCreateAgent={noop}
        onAgent={noop}
        onAssign={async () => {}}
        renderFiles={empty}
        renderActivity={empty}
        renderThreads={empty}
        renderHistory={empty}
        onEdit={noop}
        onNewTask={noop}
        onWorkflows={noop}
        onTeams={noop}
        onBriefNavigate={noop}
      />
    ) : (
      <ProjectBrief
        projectId={initial.project}
        initial={initial}
        acknowledgements={receipts.get(key)!}
        connections={[]}
        agents={[]}
        onNavigate={noop}
        onChanged={(page) =>
          state.briefChanges.push(page.headline?.text || "empty")
        }
      />
    ),
  );
};
