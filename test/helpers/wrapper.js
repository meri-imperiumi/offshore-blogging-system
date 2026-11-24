// Minimal 2.x replacement for the retired noflo-wrapper Tester.
//
// Loads a component through the @noflo/loader-node registry (so library
// prefixes like `signalk-offshore-blogging/GribChunker` resolve), then
// drives the bare instance with internal sockets — no wrapping network.
//
// Sockets are EventTargets in NoFlo 2.x: listen with onData() below (or
// `socket.addEventListener("ip", (event) => ...)` and filter on
// `event.detail.type === "data"`; the payload is `event.detail.data`).

import { createNodeModulesRegistry } from "@noflo/loader-node";
import { IP, internalSocket } from "@noflo/noflo";

let registryPromise = null;

function getRegistry() {
  if (!registryPromise) {
    registryPromise = createNodeModulesRegistry(process.cwd());
  }
  return registryPromise;
}

export { IP };

/** Call callback(payload, ip) for each data IP delivered on the socket. */
export function onData(socket, callback) {
  socket.addEventListener("ip", (event) => {
    const ip = event.detail;
    if (ip.type === "data") callback(ip.data, ip);
  });
}

/** Resolve with the next data IP payload delivered on the socket. */
export function nextData(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Timed out waiting for data IP")),
      timeoutMs,
    );
    socket.addEventListener(
      "ip",
      (event) => {
        const ip = event.detail;
        if (ip.type !== "data") return;
        clearTimeout(timer);
        resolve(ip.data);
      },
      { once: true },
    );
  });
}

export default class Tester {
  constructor(componentName) {
    this.componentName = componentName;
    this.instance = null;
    this.ins = {};
    this.outs = {};
    // Relay surface for process errors: direct-driven components have no
    // NoFlo network, so socket-level error events are re-emitted here as
    // `process-error` CustomEvents (detail: { id, error }) the same shape
    // Network uses.
    this.network = new EventTarget();
  }

  async start() {
    const registry = await getRegistry();
    await registry.discover();
    const impl = await registry.get(this.componentName);
    if (!impl) {
      throw new Error(`Component ${this.componentName} not found`);
    }
    const instance = impl.getComponent();
    this.instance = instance;
    const attach = (name, port, bag) => {
      const socket = internalSocket.createSocket();
      socket.addEventListener("error", (event) => {
        this.network.dispatchEvent(
          new CustomEvent("process-error", {
            detail: { id: name, error: event.detail?.error || event.detail },
          }),
        );
      });
      port.attach(socket);
      bag[name] = socket;
    };
    for (const [name, port] of Object.entries(instance.inPorts.ports)) {
      attach(name, port, this.ins);
    }
    for (const [name, port] of Object.entries(instance.outPorts.ports)) {
      attach(name, port, this.outs);
    }
    return instance;
  }
}
