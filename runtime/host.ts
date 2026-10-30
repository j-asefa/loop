import "./environment.mjs";
export {};
// Start this as the laptop user in the project directory. Pair only a trusted
// Loop55 workspace: native agents have that user's shell, files and tools.
process.env.LOOP55_RUNTIME_MODE = "host";
await import("./broker.ts");
