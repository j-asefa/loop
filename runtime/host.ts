export {};
// Start this as the laptop user in the project directory. Pair only a trusted
// Loop workspace: native agents have that user's shell, files and tools.
process.env.LOOP_RUNTIME_MODE = "host";
await import("./broker.ts");
