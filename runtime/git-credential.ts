import { readFileSync } from "node:fs";
// Git invokes this through its credential-helper protocol. Only HTTPS GitHub
// requests receive the per-turn token; store/erase never persist anything.
if (process.argv[2] === "get") {
  const fields = Object.fromEntries(
    readFileSync(0, "utf8")
      .split("\n")
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 0
          ? [line, ""]
          : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const token = process.env.GH_TOKEN;
  if (
    fields.protocol === "https" &&
    fields.host?.toLowerCase() === "github.com" &&
    token &&
    !/[\r\n\0]/.test(token)
  )
    process.stdout.write(`username=x-access-token\npassword=${token}\n\n`);
}
