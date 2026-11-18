import os from "node:os";
import path from "node:path";

// 测试永远不读工作区里的 upstreams.json / quota.json：
// 否则本机一旦开了多上游，所有"单上游语义"的用例都会跟着挂。
process.env.MIMO_BRIDGE_UPSTREAMS = path.join(os.tmpdir(), "bridge-test-no-registry.json");
process.env.MIMO_BRIDGE_QUOTA = path.join(os.tmpdir(), "bridge-test-no-quota.json");

export default true;
