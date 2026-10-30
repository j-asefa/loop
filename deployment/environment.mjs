// Preserve configured credentials and paths during the Loop55 upgrade. New names win.
export function upgradeEnvironment(env) {
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith("LOOP_") && value !== undefined) {
      const renamed = "LOOP55_" + name.slice(5);
      if (env[renamed] === undefined) env[renamed] = value;
      delete env[name];
    }
  }
  return env;
}
upgradeEnvironment(process.env);
