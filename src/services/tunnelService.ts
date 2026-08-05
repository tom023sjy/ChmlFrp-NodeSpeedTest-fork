import {
  createTunnel,
  deleteTunnel,
  fetchTunnels,
  fetchNodeInfo,
  type Tunnel,
  type CreateTunnelParams,
  getStoredUser,
} from "./api";

export interface TempTunnelInfo {
  tunnelId: number;
  tunnelName: string;
  localPort: number;
  remotePort: number;
  nodeName: string;
  nodeIp: string;
  nodeToken: string;
  serverPort: number;
}

function parsePortRange(rport: string): number[] {
  if (!rport) {
    return [20000, 40000];
  }

  if (rport.includes("-")) {
    const [start, end] = rport.split("-").map((s) => parseInt(s.trim(), 10));
    if (!isNaN(start) && !isNaN(end)) {
      return [start, end];
    }
  }

  const singlePort = parseInt(rport, 10);
  if (!isNaN(singlePort)) {
    return [singlePort, singlePort];
  }

  return [20000, 40000];
}

function getRandomPort(min: number, max: number, excludePorts: Set<number> = new Set()): number {
  // 端口范围过小时直接遍历候选
  const range = max - min + 1;
  if (range <= 0) return min;

  // 候选端口数过少时遍历所有可用端口
  const available: number[] = [];
  for (let p = min; p <= max; p++) {
    if (!excludePorts.has(p)) available.push(p);
  }
  if (available.length === 0) {
    // 所有端口都试过了，回退到纯随机（大概率仍会失败，但避免死循环）
    return Math.floor(Math.random() * range) + min;
  }
  const idx = Math.floor(Math.random() * available.length);
  return available[idx];
}

/// 判断错误信息是否表示远程端口已被占用
/// ChmlFrp API 可能返回：「该远程端口已被占用」「端口被占用」「port already in use」等
function isPortInUseError(message: string): boolean {
  const lower = message.toLowerCase();
  // 中文关键字
  if (message.includes("端口") && message.includes("占用")) return true;
  if (message.includes("已被占用")) return true;
  // 英文关键字
  if (lower.includes("port") && (lower.includes("used") || lower.includes("occup") || lower.includes("exist"))) return true;
  if (lower.includes("already in use")) return true;
  return false;
}

/// 创建临时隧道时的最大重试次数（端口冲突时自动更换端口重试）
const MAX_PORT_RETRY = 5;

export class TunnelService {
  private tempTunnel: TempTunnelInfo | null = null;

  async createTempTunnel(
    localPort: number,
    nodeName: string,
  ): Promise<TempTunnelInfo> {
    const user = getStoredUser();
    if (!user) {
      throw new Error("请先登录");
    }

    const nodeInfo = await fetchNodeInfo(nodeName);
    const [minPort, maxPort] = parsePortRange(nodeInfo.rport || "");

    // 记录已尝试过且失败的端口，避免重复抽到同一端口
    const failedPorts = new Set<number>();
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < MAX_PORT_RETRY; attempt++) {
      const remotePort = getRandomPort(minPort, maxPort, failedPorts);
      // 每次重试使用新的隧道名（避免与服务端残留冲突）
      const tunnelName = `speedtest_${Date.now()}_${attempt}`;

      const params: CreateTunnelParams = {
        tunnelname: tunnelName,
        node: nodeName,
        localip: "127.0.0.1",
        porttype: "tcp",
        localport: localPort,
        remoteport: remotePort,
        encryption: false,
        compression: false,
        extraparams: "",
      };

      try {
        await createTunnel(params);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        lastError = err instanceof Error ? err : new Error(errMsg);

        if (isPortInUseError(errMsg)) {
          // 端口占用：记录失败端口，更换端口重试
          console.warn(`[TunnelService] 远程端口 ${remotePort} 已被占用，尝试更换端口重试 (${attempt + 1}/${MAX_PORT_RETRY})`);
          failedPorts.add(remotePort);
          continue;
        }
        // 非端口占用错误：直接抛出，不重试
        throw lastError;
      }

      // 创建隧道成功，拉取隧道列表确认
      const tunnels = await fetchTunnels();
      const newTunnel = tunnels.find((t: Tunnel) => t.name === tunnelName);

      if (!newTunnel) {
        // 列表中未找到，可能是 API 延迟，也作为可重试错误
        console.warn(`[TunnelService] 隧道创建后未在列表中找到，尝试重试 (${attempt + 1}/${MAX_PORT_RETRY})`);
        failedPorts.add(remotePort);
        lastError = new Error("创建隧道失败：未找到新创建的隧道");
        continue;
      }

      console.log("[TunnelService] Created tunnel:", {
        name: newTunnel.name,
        dorp: newTunnel.dorp,
        server_port: newTunnel.server_port,
        ip: newTunnel.ip,
        node_ip: newTunnel.node_ip,
      });

      const parsedRemotePort = parseInt(newTunnel.dorp, 10);
      const finalRemotePort = parsedRemotePort > 0 ? parsedRemotePort : remotePort;

      console.log("[TunnelService] Remote port:", {
        dorp: newTunnel.dorp,
        parsedRemotePort,
        fallbackRemotePort: remotePort,
        finalRemotePort,
      });

      console.log("[TunnelService] Node info:", {
        name: nodeInfo.name,
        ip: nodeInfo.ip,
        realIp: nodeInfo.realIp,
        real_IP: nodeInfo.real_IP,
        nodetoken: nodeInfo.nodetoken ? "(exists)" : "(missing)",
      });

      const nodeIp = nodeInfo.ip || nodeInfo.realIp || nodeInfo.real_IP || newTunnel.node_ip;
      if (!nodeIp) {
        throw new Error("无法获取节点IP地址");
      }

      const serverPort = newTunnel.server_port || nodeInfo.port || 7000;

      console.log("[TunnelService] Using node IP:", nodeIp);
      console.log("[TunnelService] Using server port:", serverPort);

      this.tempTunnel = {
        tunnelId: newTunnel.id,
        tunnelName: tunnelName,
        localPort: localPort,
        remotePort: finalRemotePort,
        nodeName: nodeName,
        nodeIp: nodeIp,
        nodeToken: nodeInfo.nodetoken || newTunnel.node_token,
        serverPort: serverPort,
      };

      return this.tempTunnel;
    }

    // 所有重试均失败
    throw lastError ?? new Error(`创建隧道失败：已重试 ${MAX_PORT_RETRY} 次仍无法找到可用端口`);
  }

  async deleteTempTunnel(): Promise<void> {
    if (!this.tempTunnel) {
      return;
    }

    try {
      await deleteTunnel(this.tempTunnel.tunnelId);
    } finally {
      this.tempTunnel = null;
    }
  }

  /**
   * 彻底清理所有遗留的临时隧道（speedtest_ 前缀）
   * 用于测速结束兜底，避免异常退出/记录丢失导致隧道残留
   * 宁可多调用 API 也不放过任何一个
   * @returns 实际删除的隧道数量
   */
  async cleanupAllTempTunnels(): Promise<number> {
    const TEMP_TUNNEL_PREFIX = "speedtest";
    try {
      const tunnels = await fetchTunnels();
      const tempTunnels = tunnels.filter((t) =>
        t.name?.toLowerCase().startsWith(TEMP_TUNNEL_PREFIX),
      );
      if (tempTunnels.length === 0) return 0;

      const results = await Promise.allSettled(
        tempTunnels.map((t) => deleteTunnel(t.id)),
      );
      const succeeded = results.filter(
        (r) => r.status === "fulfilled",
      ).length;

      // 清理完成后重置内部记录，避免后续 deleteTempTunnel 重复调用已删除的隧道
      this.tempTunnel = null;
      return succeeded;
    } catch {
      // 拉取列表失败时不阻塞主流程
      return 0;
    }
  }

  getTempTunnel(): TempTunnelInfo | null {
    return this.tempTunnel;
  }

  async getTunnelInfo(tunnelId: number): Promise<Tunnel | null> {
    const tunnels = await fetchTunnels();
    return tunnels.find((t: Tunnel) => t.id === tunnelId) || null;
  }
}

export const tunnelService = new TunnelService();
