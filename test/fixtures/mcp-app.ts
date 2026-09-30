import { App } from "@modelcontextprotocol/ext-apps";
const app = new App({ name: "Loop fixture app", version: "1" }, {});
const text = (id: string, value: string) => {
  document.getElementById(id)!.textContent = value;
};
app.ontoolresult = () => text("status", "Fixture result received");
document.getElementById("allowed")!.onclick = async () => {
  const r = await app.callServerTool({
    name: "metrics",
    arguments: { query: "fixture app refresh" },
  });
  text("status", JSON.stringify(r));
};
document.getElementById("denied")!.onclick = async () => {
  const r = await app.callServerTool({
    name: "delete_everything",
    arguments: {},
  });
  text("denial", JSON.stringify(r));
};
document.getElementById("parent")!.onclick = () => {
  try {
    text("isolation", parent.document.cookie || "Unexpected access");
  } catch {
    text("isolation", "Parent DOM denied");
  }
};
document.getElementById("link")!.onclick = async () => {
  try {
    await app.openLink({ url: "https://example.com" });
    text("capability", "Unexpected link permission");
  } catch {
    text("capability", "Unsupported capability denied");
  }
};
void app.connect().catch((e) => text("status", String(e)));
