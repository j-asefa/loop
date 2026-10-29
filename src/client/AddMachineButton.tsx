import { useId } from "react";
import { ArrowUpRight, Laptop, Plus } from "lucide-react";
import "./fleet.css";

export function AddMachineButton({ open }: { open: () => void }) {
  const descriptionId = useId();
  return (
    <button
      type="button"
      className="fleet-add-machine"
      aria-label="Add machine"
      aria-describedby={descriptionId}
      onClick={open}
    >
      <span className="fleet-add-machine-icon" aria-hidden="true">
        <Laptop size={25} strokeWidth={1.8} />
        <Plus className="fleet-add-machine-plus" size={17} strokeWidth={2.5} />
      </span>
      <span className="fleet-add-machine-copy">
        <strong>Add machine</strong>
        <span id={descriptionId}>All your computers, one workspace.</span>
      </span>
      <ArrowUpRight
        className="fleet-add-machine-arrow"
        size={20}
        aria-hidden="true"
      />
    </button>
  );
}
