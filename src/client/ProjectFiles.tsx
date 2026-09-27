import { useState, type ComponentProps } from "react";
import { ArrowLeft } from "lucide-react";
import { Saved, folderPath } from "./Workspace";

export function ProjectFiles(props: ComponentProps<typeof Saved>) {
  const [folder, setFolder] = useState(props.folder);
  const current = props.folders.find((item) => item.id === folder);
  return (
    <>
      {folder !== props.folder && (
        <button
          className="text-button"
          onClick={() => setFolder(current?.parent_id || props.folder)}
        >
          <ArrowLeft size={16} /> {folderPath(folder, props.folders)}
        </button>
      )}
      <Saved {...props} embedded folder={folder} onFolder={setFolder} />
    </>
  );
}
