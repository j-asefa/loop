import { capabilities } from "./capabilities";
import { PairedDevices } from "./PairedDevices";
import { AddMachineButton } from "./AddMachineButton";
import { useFleet } from "./FleetContext";
import { FleetSettings } from "./FleetSettings";
import { useState } from "react";
import { Server, Smartphone } from "lucide-react";
import { Sheet } from "./components";
import { SettingsList, SettingsRow } from "./SettingsUI";

function CompanionRuntimeHosts({ onClose }: { onClose: () => void }) {
  const { state, error } = useFleet();
  const [fleetOpen, setFleetOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const showAddMachine = !error && state?.state === "standalone";
  return (
    <>
      <Sheet title="Runtime machines" onClose={onClose}>
        <p className="settings-intro">
          Connect and manage the computers that run your agents.
        </p>
        {showAddMachine && <AddMachineButton open={() => setFleetOpen(true)} />}
        <SettingsList>
          {!showAddMachine && (state || error) && (
            <SettingsRow
              icon={Server}
              title="Machines & fleet"
              ariaLabel="Machines & fleet"
              description={error || "Add, re-pair and manage your machines"}
              onClick={() => setFleetOpen(true)}
            />
          )}
          <SettingsRow
            icon={Smartphone}
            title="This computer & paired devices"
            description="Manage devices connected to this computer"
            onClick={() => setDevicesOpen(true)}
          />
        </SettingsList>
      </Sheet>
      {fleetOpen && <FleetSettings onClose={() => setFleetOpen(false)} />}
      {devicesOpen && <PairedDevices onClose={() => setDevicesOpen(false)} />}
    </>
  );
}

export function RuntimeHosts({ onClose }: { onClose: () => void }) {
  return capabilities.pairedDevices ? (
    <CompanionRuntimeHosts onClose={onClose} />
  ) : null;
}
