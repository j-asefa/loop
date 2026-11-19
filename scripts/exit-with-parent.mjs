// Preloaded for directly supervised Node children on non-Linux hosts.
if (!process.connected) process.exit(143);
process.once("disconnect", () => {
  // Windows terminates the process before JS cleanup when sent SIGTERM.
  if (!process.emit("SIGTERM")) process.exit(143);
});
process.channel.unref();
