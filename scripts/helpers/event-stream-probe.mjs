/** Installed in the page by the browser fixture. Observe actual transport
 * frames and subscriptions; keep logical source evidence separate from sockets.
 * Explicit reset injection preserves the captured source envelope. */
export function installEventStreamProbe() {
  const Original = window.WebSocket;
  window.__eventSockets = [];
  window.__eventStreams = [];
  window.WebSocket = class extends Original {
    constructor(...args) {
      super(...args);
      this.__streams = new Map();
      this.__multiplex =
        new URL(this.url).pathname === "/api/events/multiplex/ws";
      window.__eventSockets.push(this);
      if (!this.__multiplex) {
        const match = new URL(this.url).pathname.match(
          /\/agent-sources\/([^/]+)\//,
        );
        this.__stream("", match ? decodeURIComponent(match[1]) : "");
      }
      this.addEventListener("message", (event) => {
        const packet = JSON.parse(event.data);
        if (this.__multiplex && packet.type === "closed") {
          const stream = this.__streams.get(packet.id);
          if (stream) stream.active = false;
          return;
        }
        const stream = this.__multiplex
          ? this.__stream(packet.id, packet.source)
          : this.__streams.get("");
        const frame = this.__multiplex ? packet.frame : packet;
        if (frame?.v === 3) stream.cursor = frame.cursor;
        if (frame?.type === "reset") stream.reset = frame;
      });
    }
    __stream(id, source) {
      let stream = this.__streams.get(id);
      if (!stream) {
        stream = {
          id,
          source,
          socket: this,
          active: true,
          get readyState() {
            return this.active ? this.socket.readyState : Original.CLOSED;
          },
        };
        this.__streams.set(id, stream);
        window.__eventStreams.push(stream);
      }
      return stream;
    }
    send(data) {
      if (this.__multiplex) {
        const packet = JSON.parse(data);
        if (packet.type === "subscribe")
          this.__stream(packet.id, packet.source).active = true;
        else if (packet.type === "unsubscribe") {
          const stream = this.__streams.get(packet.id);
          if (stream) stream.active = false;
        }
      }
      return super.send(data);
    }
  };
  window.__sourceStream = (source) =>
    window.__eventStreams
      .filter(
        (stream) =>
          stream.source === source && stream.readyState === Original.OPEN,
      )
      .at(-1);
  window.__injectSourceReset = (source, clock) => {
    const stream = window.__sourceStream(source);
    if (!stream?.reset || !stream.socket.onmessage)
      throw new Error("Missing reset-capable source stream");
    const frame = { ...stream.reset, ...clock, type: "reset" };
    const packet = stream.socket.__multiplex
      ? { v: 1, type: "frame", id: stream.id, source, frame }
      : frame;
    stream.socket.onmessage(
      new MessageEvent("message", { data: JSON.stringify(packet) }),
    );
  };
}
