import net from "node:net";
import tls from "node:tls";

const unavailable = () => { throw new Error("offline_network_disabled"); };
globalThis.fetch = unavailable;
net.connect = unavailable;
net.createConnection = unavailable;
tls.connect = unavailable;
