import { useState, type Dispatch, type SetStateAction } from "react";

export function useSheetNavigation({
  sheet,
  setSheet,
  returnTo,
  setReturnTo,
}: {
  sheet: string;
  setSheet: Dispatch<SetStateAction<string>>;
  returnTo: string;
  setReturnTo: Dispatch<SetStateAction<string>>;
}) {
  const [settingsParent, setSettingsParent] = useState(false);
  const [returnToTeamDirectory, setReturnToTeamDirectory] = useState(false);
  const [environmentToOpen, setEnvironmentToOpen] = useState("");
  const [environmentSetupProvider, setEnvironmentSetupProvider] = useState("");
  function closeSheet() {
    if (sheet === "create") {
      setEnvironmentToOpen("");
      setEnvironmentSetupProvider("");
    }
    if (sheet === "teams" && returnToTeamDirectory) {
      setSheet("teamDirectory");
      setReturnToTeamDirectory(false);
      setReturnTo("");
      return;
    }
    setSheet(
      sheet === "create" && ["share", "teams"].includes(returnTo)
        ? returnTo
        : sheet === "environments" && returnTo === "create"
          ? "create"
          : settingsParent
            ? "settings"
            : "",
    );
    setReturnTo("");
  }
  function openSettingsPage(page: string) {
    setSettingsParent(true);
    setSheet(page);
  }
  return {
    settingsParent,
    setSettingsParent,
    setReturnToTeamDirectory,
    environmentToOpen,
    setEnvironmentToOpen,
    environmentSetupProvider,
    setEnvironmentSetupProvider,
    closeSheet,
    openSettingsPage,
  };
}
