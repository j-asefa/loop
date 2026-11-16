import { createContext, useContext, type ReactNode } from "react";
import type { Capabilities } from "../shared/capabilities";
import { capabilities } from "./capabilities";

const ShellCapabilities = createContext<Capabilities | null>(null);

export function ShellCapabilitiesProvider({
  value,
  children,
}: {
  value: Capabilities;
  children: ReactNode;
}) {
  return (
    <ShellCapabilities.Provider value={value}>
      {children}
    </ShellCapabilities.Provider>
  );
}

export function useShellCapabilities() {
  return useContext(ShellCapabilities) ?? capabilities;
}
