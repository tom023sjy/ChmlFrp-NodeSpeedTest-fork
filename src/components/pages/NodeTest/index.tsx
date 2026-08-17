import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import {
  useTable,
  tableFeatures,
  createColumnHelper,
  createSortedRowModel,
  rowSortingFeature,
  columnSizingFeature,
  columnResizingFeature,
  type ColumnDef,
  type SortingState,
  type ColumnSizingState,
  type Header,
} from "@tanstack/react-table";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyMedia,
  EmptyContent,
} from "@/components/ui/empty";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Select } from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  Network,
  RefreshCw,
  CheckCircle2,
  XCircle,
  Clock,
  Filter,
  History,
  Globe,
  Users,
  ArrowUpDown,
  ArrowUp,
  ArrowDown,
  Search,
  CheckSquare,
  Square,
  SquareX,
  Download,
  Zap,
  Loader2,
  ArrowRightLeft,
  Monitor,
  Server,
  ChevronDown,
  Eye,
} from "lucide-react";
import { toast } from "sonner";
import { fetchNodes, type Node, type StoredUser } from "@/services/api";
import { getInitialEffectType, type EffectType } from "@/lib/settings-utils";
import {
  SpeedTestDialog,
  getBatchTestState,
  subscribeBatchTestState,
  requestStopBatchTest,
  requestForceStopBatchTest,
  requestCancelStopBatchTest,
} from "@/components/dialogs/BatchSpeedTestDialog";
import { BatchTestFloatingWidget } from "@/components/dialogs/BatchTestFloatingWidget";
import { NodeHistoryDialog } from "@/components/dialogs/NodeHistoryDialog";
import { TestHistoryDetailDialog } from "@/components/dialogs/TestHistoryDetailDialog";
import {
  PairSelectorDialog,
  type DevicePair,
} from "@/components/dialogs/PairSelectorDialog";
import { addTestHistory, type TestHistoryRecord } from "@/services/testHistoryService";
import { reportUsage } from "@/services/backendApi";
import { type SpeedSample } from "@/services/speedSamples";
import {
  aggregateStatistic,
  getStoredStatisticMode,
  NODE_TEST_PREFERENCES_CHANGED,
  type StatisticMode,
} from "@/services/nodeTestPreferences";
import {
  DEFAULT_DEVICE_PAIR,
  loadDevicePair,
  saveDevicePair,
} from "@/services/devicePairStorage";

interface NodeTestProps {
  user: StoredUser | null;
  onTestingChange?: (testing: boolean) => void;
}

interface NodeWithTest extends Node {
  testStatus?: "idle" | "testing" | "success" | "failed";
  latency?: number;
  downloadSpeed?: number;
  error?: string;
  lastTested?: number;
  latencySamples?: Array<number | null>;
  speedSamples?: SpeedSample[];
}

interface SavedTestResult {
  id: number;
  testStatus: "idle" | "testing" | "success" | "failed";
  latency?: number;
  downloadSpeed?: number;
  error?: string;
  lastTested?: number;
  latencySamples?: Array<number | null>;
  speedSamples?: SpeedSample[];
}

/** 按设备对存储的测试结果：pairKey → 结果列表 */
type PairResultsMap = Record<string, SavedTestResult[]>;

interface TestHistory {
  id: string;
  nodeId: number;
  nodeName: string;
  area: string;
  nodegroup: string;
  china: string;
  success: boolean;
  latency?: number;
  error?: string;
  timestamp: number;
  /** 测试时使用的设备对（旧记录无此字段，视为 本机→本机） */
  senderId?: string;
  senderName?: string;
  receiverId?: string;
  receiverName?: string;
  pairKey?: string;
}

/** 默认设备对：本机 → 本机（即原始节点测试） */
const DEFAULT_PAIR = DEFAULT_DEVICE_PAIR;

/** 根据设备对生成存储 key */
function pairKeyOf(pair: DevicePair): string {
  return `${pair.senderId}__${pair.receiverId}`;
}

/**
 * 计算节点推荐值（0-100 分，保留两位小数）。
 * 算法：速度得分（权重 60%）+ 延迟得分（权重 40%）
 * - 速度得分：以 100Mbps 为满分基准线性归一化，超过 100Mbps 记 100 分
 * - 延迟得分：100 - 延迟(ms) × 0.2，低于 0 记 0 分（即 500ms 得 0 分）
 * - 未测试或测试失败的节点返回 null（不显示分数）
 */
function calcRecommendScore(node: NodeWithTest): number | null {
  if (
    node.testStatus !== "success" ||
    node.latency == null ||
    node.downloadSpeed == null
  ) {
    return null;
  }
  const speedScore = Math.min(node.downloadSpeed / 100, 1) * 100;
  const latencyScore = Math.max(0, 100 - node.latency * 0.2);
  const score = speedScore * 0.6 + latencyScore * 0.4;
  return Math.round(score * 100) / 100;
}

type UserTypeFilter = "all" | "vip" | "normal";
type RegionFilter = "all" | "domestic" | "foreign";

const regionOptions = [
  { value: "all", label: "全部" },
  { value: "domestic", label: "国内" },
  { value: "foreign", label: "国外" },
];

const userTypeOptions = [
  { value: "all", label: "全部" },
  { value: "vip", label: "VIP" },
  { value: "normal", label: "普通" },
];

// ===== TanStack Table v9 Feature 注册 =====
// 排序 + 列宽调整 + 列宽拖拽交互
const features = tableFeatures({
  rowSortingFeature,
  sortedRowModel: createSortedRowModel(),
  columnSizingFeature,
  columnResizingFeature,
});

const columnHelper = createColumnHelper<typeof features, NodeWithTest>();

/**
 * 列配置常量（用于动态列宽测量和列定义）
 * - id: 列标识（与 TanStack column id 一致）
 * - defaultSize: 静态默认列宽（px）
 * - minSize: 最小列宽（px），防止列被压缩到无法显示
 * - enableSorting: 是否允许排序
 */
interface ColumnConfig {
  id: string;
  defaultSize: number;
  minSize: number;
  enableSorting: boolean;
}

const COLUMN_CONFIG: ColumnConfig[] = [
  { id: "select", defaultSize: 48, minSize: 36, enableSorting: false },
  { id: "id", defaultSize: 64, minSize: 48, enableSorting: true },
  { id: "name", defaultSize: 180, minSize: 80, enableSorting: false },
  { id: "area", defaultSize: 140, minSize: 60, enableSorting: false },
  { id: "nodegroup", defaultSize: 80, minSize: 64, enableSorting: false },
  { id: "china", defaultSize: 80, minSize: 64, enableSorting: false },
  { id: "status", defaultSize: 96, minSize: 80, enableSorting: false },
  { id: "latency", defaultSize: 80, minSize: 64, enableSorting: true },
  { id: "downloadSpeed", defaultSize: 96, minSize: 80, enableSorting: true },
  { id: "recommendScore", defaultSize: 88, minSize: 72, enableSorting: true },
];

// 列宽缓存 key（按账号隔离）
const COLUMN_SIZING_CACHE_KEY = "node_column_widths";

export function NodeTest({ user, onTestingChange }: NodeTestProps) {
  // 按账号隔离的本地缓存 key
  // 旧数据（无后缀）首次访问时自动迁移到当前账号名下
  const username = user?.username;
  const cacheKey = useCallback(
    (suffix: string) => {
      if (!username) return suffix;
      return `${suffix}__${username}`;
    },
    [username],
  );
  // 一次性迁移旧 key 数据到当前账号
  const migrateLegacyCache = useCallback(
    (suffix: string) => {
      if (!username) return;
      const newKey = cacheKey(suffix);
      if (localStorage.getItem(newKey)) return;
      const legacy = localStorage.getItem(suffix);
      if (!legacy) return;
      try {
        JSON.parse(legacy);
        localStorage.setItem(newKey, legacy);
        localStorage.removeItem(suffix);
      } catch {
        // 旧数据格式错误，跳过
      }
    },
    [username, cacheKey],
  );

  // 初始化时尝试从缓存加载节点列表，避免切换页面回来时短暂空白
  // 测试结果从 local__local 设备对加载（兼容旧格式自动迁移）
  const [nodes, setNodes] = useState<NodeWithTest[]>(() => {
    try {
      // 初始化阶段 user 可能还未加载，先用旧 key（无后缀）兜底
      const cachedNodes = localStorage.getItem("node_list_cache");
      if (!cachedNodes) return [];
      const parsedNodes = JSON.parse(cachedNodes) as Node[];

      // 加载测试结果：优先新格式（按设备对），兼容旧格式（扁平列表）
      const defaultPairKey = pairKeyOf(DEFAULT_PAIR);
      let parsedResults: SavedTestResult[] = [];
      const newResultsKey = "node_test_results_by_pair";
      const newSaved = localStorage.getItem(newResultsKey);
      if (newSaved) {
        const map = JSON.parse(newSaved) as PairResultsMap;
        parsedResults = map[defaultPairKey] ?? [];
      } else {
        // 尝试旧格式
        const legacyResults = localStorage.getItem("node_test_results");
        if (legacyResults) {
          try {
            parsedResults = JSON.parse(legacyResults) as SavedTestResult[];
          } catch {
            parsedResults = [];
          }
        }
      }

      const resultsMap = new Map<number, SavedTestResult>(
        parsedResults.map((r) => [r.id, r]),
      );
      return parsedNodes.map((node) => {
        const savedResult = resultsMap.get(node.id);
        if (savedResult) {
          return {
            ...node,
            testStatus: savedResult.testStatus,
            latency: savedResult.latency,
            downloadSpeed: savedResult.downloadSpeed,
            error: savedResult.error,
            lastTested: savedResult.lastTested,
            latencySamples: savedResult.latencySamples,
            speedSamples: savedResult.speedSamples,
          };
        }
        return { ...node, testStatus: "idle" as const };
      });
    } catch {
      // 缓存解析失败，返回空数组
    }
    return [];
  });
  const [loading, setLoading] = useState(false);
  const [testingAll, setTestingAll] = useState(false);
  const [testHistory, setTestHistory] = useState<TestHistory[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [selectedHistoryRecord, setSelectedHistoryRecord] = useState<TestHistoryRecord | null>(null);
  const [userTypeFilter, setUserTypeFilter] = useState<UserTypeFilter>("all");
  const [regionFilter, setRegionFilter] = useState<RegionFilter>("all");
  const [effectType, setEffectType] = useState<EffectType>(() =>
    getInitialEffectType(),
  );
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedNodeIds, setSelectedNodeIds] = useState<Set<number>>(
    new Set(),
  );
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [batchTestNodes, setBatchTestNodes] = useState<NodeWithTest[] | null>(
    null,
  );
  const [showBatchTestDialog, setShowBatchTestDialog] = useState(false);
  const [historyNode, setHistoryNode] = useState<{
    node: NodeWithTest;
    type: "latency" | "speed";
  } | null>(null);
  // 批量测试是否处于软停止中（用于顶栏显示"取消停止"和"强制停止"按钮）
  const [isBatchStopping, setIsBatchStopping] = useState(false);
  const [latencyStatistic, setLatencyStatistic] = useState<StatisticMode>(() =>
    getStoredStatisticMode(localStorage, "latency"),
  );
  const [speedStatistic, setSpeedStatistic] = useState<StatisticMode>(() =>
    getStoredStatisticMode(localStorage, "speed"),
  );

  useEffect(() => {
    const handlePreferencesChanged = () => {
      setLatencyStatistic(getStoredStatisticMode(localStorage, "latency"));
      setSpeedStatistic(getStoredStatisticMode(localStorage, "speed"));
    };
    window.addEventListener(NODE_TEST_PREFERENCES_CHANGED, handlePreferencesChanged);
    return () =>
      window.removeEventListener(NODE_TEST_PREFERENCES_CHANGED, handlePreferencesChanged);
  }, []);

  // ===== 设备对相关状态 =====
  // 当前查看的设备对（默认本机自测），表格显示该设备对的测试结果
  const [currentPair, setCurrentPair] = useState<DevicePair>(() =>
    loadDevicePair(localStorage, username),
  );
  // 设备对选择弹窗
  const [showPairSelector, setShowPairSelector] = useState(false);
  // 所有设备对的测试结果（按 pairKey 索引）
  // 初始化时从 localStorage 加载，并兼容旧格式（扁平列表）迁移到 local__local
  const [pairResults, setPairResults] = useState<PairResultsMap>(() => {
    try {
      const defaultPairKey = pairKeyOf(DEFAULT_PAIR);
      const newResultsKey = "node_test_results_by_pair";
      const newSaved = localStorage.getItem(newResultsKey);
      if (newSaved) {
        return JSON.parse(newSaved) as PairResultsMap;
      }
      // 尝试旧格式迁移
      const legacyResults = localStorage.getItem("node_test_results");
      if (legacyResults) {
        try {
          const legacy: SavedTestResult[] = JSON.parse(legacyResults);
          return { [defaultPairKey]: legacy };
        } catch {
          return {};
        }
      }
    } catch {
      // 忽略
    }
    return {};
  });

  // ===== TanStack Table 状态 =====
  // 排序状态（默认按编号升序）
  const [sorting, setSorting] = useState<SortingState>([
    { id: "id", desc: false },
  ]);

  // 列宽状态：从 localStorage 恢复用户自定义列宽（按账号隔离）
  // 三层列宽体系：columnSizing（用户拖拽调整） > autoColumnWidths（内容测量默认值） > defaultSize（静态默认值）
  const [columnSizing, setColumnSizing] = useState<ColumnSizingState>(() => {
    try {
      const legacy = localStorage.getItem(COLUMN_SIZING_CACHE_KEY);
      const key = username
        ? `${COLUMN_SIZING_CACHE_KEY}__${username}`
        : COLUMN_SIZING_CACHE_KEY;
      // 一次性迁移旧 key 数据到当前账号
      if (!localStorage.getItem(key) && legacy) {
        try {
          JSON.parse(legacy);
          localStorage.setItem(key, legacy);
          localStorage.removeItem(COLUMN_SIZING_CACHE_KEY);
        } catch {
          // 旧数据格式错误，跳过
        }
      }
      const saved = localStorage.getItem(key);
      if (saved) {
        return JSON.parse(saved) as ColumnSizingState;
      }
    } catch {
      // 缓存解析失败，使用空对象（全部使用默认列宽）
    }
    return {};
  });

  // 动态列宽测量结果：根据表格内容自动计算每列最小展示宽度
  const [autoColumnWidths, setAutoColumnWidths] = useState<
    Record<string, number>
  >({});

  // 持久化列宽到 localStorage
  useEffect(() => {
    const key = username
      ? `${COLUMN_SIZING_CACHE_KEY}__${username}`
      : COLUMN_SIZING_CACHE_KEY;
    try {
      localStorage.setItem(key, JSON.stringify(columnSizing));
    } catch {
      // 写入失败（如存储空间不足），忽略
    }
  }, [columnSizing, username]);

  // 监听设置页面"重置列宽"事件，清空所有自定义列宽
  useEffect(() => {
    function handleReset() {
      setColumnSizing({});
    }
    window.addEventListener("node-column-widths-reset", handleReset);
    return () =>
      window.removeEventListener("node-column-widths-reset", handleReset);
  }, []);

  // 使用 ref 保存最新的 testingAll 值，避免订阅频繁取消和重注册导致丢失通知
  const testingAllRef = useRef(testingAll);
  useEffect(() => {
    testingAllRef.current = testingAll;
  }, [testingAll]);

  useEffect(() => {
    return subscribeBatchTestState(() => {
      const state = getBatchTestState();
      // 测试开始时同步 testingAll 为 true，让顶部显示"测试中..."和"停止"按钮
      if (state.isRunning && !testingAllRef.current) {
        setTestingAll(true);
      }
      // 测试结束时同步 testingAll 为 false
      if (!state.isRunning && testingAllRef.current) {
        setTestingAll(false);
      }
      // 同步软停止状态
      setIsBatchStopping(state.isStopping);
    });
  }, []);

  // ===== 测试结果按设备对存储 =====
  // 存储格式：localStorage["node_test_results_by_pair__username"] = Record<pairKey, SavedTestResult[]>
  // 旧格式（localStorage["node_test_results__username"] = SavedTestResult[]）自动迁移到 "local__local" key 下
  const PAIR_RESULTS_KEY = "node_test_results_by_pair";

  const loadPairResults = useCallback((): PairResultsMap => {
    // 旧数据迁移：将旧的扁平结果列表迁移到 local__local key 下
    migrateLegacyCache("node_test_results");
    const legacyKey = cacheKey("node_test_results");
    const newKey = cacheKey(PAIR_RESULTS_KEY);
    const existing = localStorage.getItem(newKey);
    if (!existing) {
      const legacy = localStorage.getItem(legacyKey);
      if (legacy) {
        try {
          const legacyResults: SavedTestResult[] = JSON.parse(legacy);
          const migrated: PairResultsMap = {
            [pairKeyOf(DEFAULT_PAIR)]: legacyResults,
          };
          localStorage.setItem(newKey, JSON.stringify(migrated));
          // 迁移成功后删除旧 key，避免下次重复处理
          localStorage.removeItem(legacyKey);
          return migrated;
        } catch {
          // 旧数据格式错误，跳过
        }
      }
      return {};
    }
    try {
      return JSON.parse(existing) as PairResultsMap;
    } catch {
      return {};
    }
  }, [cacheKey, migrateLegacyCache]);

  const savePairResults = useCallback(
    (map: PairResultsMap) => {
      localStorage.setItem(cacheKey(PAIR_RESULTS_KEY), JSON.stringify(map));
    },
    [cacheKey],
  );

  // 保存指定设备对的测试结果
  const saveTestResultsForPair = useCallback(
    (pair: DevicePair, nodesToSave: NodeWithTest[]) => {
      const results: SavedTestResult[] = nodesToSave
        .filter(
          (
            n,
          ): n is NodeWithTest & {
            testStatus: "testing" | "success" | "failed";
          } => n.testStatus !== undefined && n.testStatus !== "idle",
        )
        .map((n) => ({
          id: n.id,
          testStatus: n.testStatus,
          latency: n.latency,
          downloadSpeed: n.downloadSpeed,
          error: n.error,
          lastTested: n.lastTested,
          latencySamples: n.latencySamples,
          speedSamples: n.speedSamples,
        }));
      setPairResults((prev) => {
        const next = { ...prev, [pairKeyOf(pair)]: results };
        savePairResults(next);
        return next;
      });
    },
    [savePairResults],
  );

  useEffect(() => {
    const handleEffectTypeChange = () => {
      const stored = localStorage.getItem("effectType");
      if (
        stored === "frosted" ||
        stored === "translucent" ||
        stored === "none"
      ) {
        setEffectType(stored);
      }
    };

    window.addEventListener("effectTypeChanged", handleEffectTypeChange);
    return () => {
      window.removeEventListener("effectTypeChanged", handleEffectTypeChange);
    };
  }, []);

  // 将节点列表与指定设备对的测试结果合并（直接从传入的 results 读取，确保最新值）
  const mergeNodesWithResults = useCallback(
    (
      fetchedNodes: Node[],
      pair: DevicePair,
      resultsMap: PairResultsMap,
    ): NodeWithTest[] => {
      const savedResults = resultsMap[pairKeyOf(pair)] ?? [];
      const resultsMapById = new Map<number, SavedTestResult>(
        savedResults.map((r) => [r.id, r]),
      );
      return fetchedNodes.map((node) => {
        const savedResult = resultsMapById.get(node.id);
        if (savedResult) {
          return {
            ...node,
            testStatus: savedResult.testStatus,
            latency: savedResult.latency,
            downloadSpeed: savedResult.downloadSpeed,
            error: savedResult.error,
            lastTested: savedResult.lastTested,
          latencySamples: savedResult.latencySamples,
          speedSamples: savedResult.speedSamples,
          };
        }
        return { ...node, testStatus: "idle" as const };
      });
    },
    [],
  );

  const loadNodes = useCallback(async () => {
    if (!user) return;

    try {
      setLoading(true);
      const fetchedNodes = await fetchNodes();
      // 加载最新的 pairResults（从 localStorage 读取，确保拿到最新数据）
      const latestPairResults = loadPairResults();
      setPairResults(latestPairResults);
      const nodesWithResults = mergeNodesWithResults(
        fetchedNodes,
        currentPairRef.current,
        latestPairResults,
      );

      setNodes(nodesWithResults);
      // 缓存节点列表，用于 API 请求失败时恢复
      migrateLegacyCache("node_list_cache");
      localStorage.setItem(
        cacheKey("node_list_cache"),
        JSON.stringify(fetchedNodes),
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "获取节点列表失败";
      // API 请求失败时，尝试从缓存恢复节点列表和测试结果
      migrateLegacyCache("node_list_cache");
      const cachedNodes = localStorage.getItem(cacheKey("node_list_cache"));
      if (cachedNodes) {
        try {
          const parsedNodes = JSON.parse(cachedNodes) as Node[];
          const latestPairResults = loadPairResults();
          setPairResults(latestPairResults);
          const nodesWithResults = mergeNodesWithResults(
            parsedNodes,
            currentPairRef.current,
            latestPairResults,
          );

          setNodes(nodesWithResults);
          toast.warning("网络请求失败，已加载缓存的节点数据");
        } catch {
          toast.error(message);
        }
      } else {
        toast.error(message);
      }
    } finally {
      setLoading(false);
    }
  }, [
    user,
    loadPairResults,
    mergeNodesWithResults,
    cacheKey,
    migrateLegacyCache,
  ]);

  const loadHistory = useCallback(() => {
    setHistoryLoading(true);
    migrateLegacyCache("node_test_history");
    const saved = localStorage.getItem(cacheKey("node_test_history"));
    if (saved) {
      try {
        setTestHistory(JSON.parse(saved));
      } catch {
        setTestHistory([]);
      }
    }
    setHistoryLoading(false);
  }, [cacheKey, migrateLegacyCache]);

  const nodesRef = useRef(nodes);
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // 使用 ref 保存最新的 currentPair，避免 loadNodes 等回调依赖频繁变化
  const currentPairRef = useRef(currentPair);
  useEffect(() => {
    currentPairRef.current = currentPair;
  }, [currentPair]);

  useEffect(() => {
    onTestingChange?.(testingAll);
  }, [testingAll, onTestingChange]);

  useEffect(() => {
    return () => {
      // 组件卸载时保存当前设备对的测试结果（仅在有节点数据时）
      if (nodesRef.current.length > 0) {
        saveTestResultsForPair(currentPairRef.current, nodesRef.current);
      }
    };
  }, [saveTestResultsForPair]);

  const stopTesting = useCallback(() => {
    // 通过全局停止处理器通知 SpeedTestDialog 停止测试
    // SpeedTestDialog 会在当前节点测试完成后停止，不立即中断
    requestStopBatchTest();
    toast.info("将在当前节点测试完成后停止");
  }, []);

  const forceStopTesting = useCallback(() => {
    // 强制停止：立即中断当前节点测试
    requestForceStopBatchTest();
    toast.warning("正在强制停止测试...");
  }, []);

  const cancelStopTesting = useCallback(() => {
    // 取消软停止，继续测试
    requestCancelStopBatchTest();
    toast.info("已取消停止，继续测试");
  }, []);

  // 切换设备对或测试结果更新时，重新合并节点列表与当前设备对的测试结果
  useEffect(() => {
    if (nodesRef.current.length === 0) return;
    // 仅保留节点基础信息（剔除旧的测试结果），再与当前设备对结果合并
    const baseNodes = nodesRef.current.map((n) => {
      const base = { ...n };
      delete base.testStatus;
      delete base.latency;
      delete base.downloadSpeed;
      delete base.error;
      delete base.lastTested;
      delete base.latencySamples;
      delete base.speedSamples;
      return base as Node;
    });
    setNodes(mergeNodesWithResults(baseNodes, currentPair, pairResults));
  }, [currentPair, pairResults, mergeNodesWithResults]);

  useEffect(() => {
    if (user) {
      void loadNodes();
      loadHistory();
    }
  }, [user, loadNodes, loadHistory]);

  const toggleSelectNode = useCallback((nodeId: number) => {
    setSelectedNodeIds((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  const highlightText = useCallback((text: string, query: string) => {
    if (!query) return text;
    const parts = text.split(new RegExp(`(${query})`, "gi"));
    return (
      <>
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <span
              key={i}
              className="bg-yellow-200 dark:bg-yellow-800 rounded px-0.5"
            >
              {part}
            </span>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
      </>
    );
  }, []);

  // 仅执行搜索/筛选，排序由 TanStack Table 的 getSortedRowModel 接管
  const filteredNodes = useMemo(() => {
    return nodes.filter((node) => {
      let matchesSearch = true;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        matchesSearch =
          node.name.toLowerCase().includes(q) ||
          node.area.toLowerCase().includes(q) ||
          node.nodegroup.toLowerCase().includes(q);
      }

      let matchesRegion = true;
      if (regionFilter === "domestic") {
        matchesRegion = node.china === "yes";
      } else if (regionFilter === "foreign") {
        matchesRegion = node.china === "no";
      }

      let matchesUserType = true;
      if (userTypeFilter === "vip") {
        matchesUserType = node.nodegroup === "vip";
      } else if (userTypeFilter === "normal") {
        matchesUserType = node.nodegroup !== "vip";
      }

      return matchesSearch && matchesRegion && matchesUserType;
    });
  }, [nodes, regionFilter, userTypeFilter, searchQuery]);

  const getDisplayedLatency = useCallback(
    (node: NodeWithTest) =>
      aggregateStatistic(
        node.latencySamples ?? [],
        latencyStatistic,
        node.latency,
      ),
    [latencyStatistic],
  );

  const getDisplayedSpeed = useCallback(
    (node: NodeWithTest) =>
      aggregateStatistic(
        node.speedSamples?.map((sample) => sample.mbps) ?? [],
        speedStatistic,
        node.downloadSpeed,
      ),
    [speedStatistic],
  );

  // ===== 动态列宽测量 =====
  // 测量每列内容最大宽度，计算动态默认列宽（展示全部内容的前提下的最小宽度）
  // 表格内容更新时自动重新测量
  // 由于 table-fixed 布局下 scrollWidth 等于列宽而非内容宽度，
  // 需要克隆表格到隐藏容器并切换为 auto 布局测量真实内容宽度
  const tableContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tableContainerRef.current || filteredNodes.length === 0) return;
    const wrapper = tableContainerRef.current;
    // 使用 requestAnimationFrame 避免阻塞渲染，并确保 DOM 已更新
    const rafId = requestAnimationFrame(() => {
      const sourceTable = wrapper.querySelector("table");
      if (!sourceTable) return;
      // 克隆表格到隐藏容器，使用 auto 布局测量真实内容宽度
      const clone = sourceTable.cloneNode(true) as HTMLTableElement;
      // 移除克隆中所有单元格的固定宽度样式，让内容决定宽度
      clone.querySelectorAll("th, td").forEach((cell) => {
        cell.removeAttribute("style");
      });
      const measureContainer = document.createElement("div");
      measureContainer.style.position = "absolute";
      measureContainer.style.left = "-9999px";
      measureContainer.style.top = "0";
      measureContainer.style.visibility = "hidden";
      // 使用 auto 布局，列宽由内容决定
      measureContainer.style.width = "max-content";
      clone.style.tableLayout = "auto";
      clone.style.width = "auto";
      measureContainer.appendChild(clone);
      document.body.appendChild(measureContainer);
      const rows = clone.querySelectorAll("tr");
      const measured: Record<string, number> = {};
      COLUMN_CONFIG.forEach((c, index) => {
        let maxWidth = c.minSize;
        rows.forEach((row) => {
          const cell = row.children[index] as HTMLElement | undefined;
          if (cell) {
            // offsetWidth 包含内容完整宽度（含内边距和边框）
            const cellWidth = cell.offsetWidth;
            if (cellWidth > maxWidth) maxWidth = cellWidth;
          }
        });
        // 加 4px 余量，避免边界情况截断
        measured[c.id] = Math.max(c.minSize, maxWidth + 4);
      });
      document.body.removeChild(measureContainer);
      setAutoColumnWidths(measured);
    });
    return () => cancelAnimationFrame(rafId);
  }, [filteredNodes]);

  // ===== TanStack Table 列定义 =====
  // 三层列宽体系：
  // 1. columnSizing（用户拖拽调整过的列宽，持久化到 localStorage）
  // 2. autoColumnWidths（根据内容动态测量的默认列宽）
  // 3. defaultSize（静态默认列宽，作为兜底）
  // TanStack 的 column.getSize() 自动合并：columnSizing[id] ?? columnDef.size
  const columns = useMemo(() => {
    const getSize = (id: string, defaultSize: number, minSize: number) => {
      const measured = autoColumnWidths[id];
      if (measured != null) return Math.max(measured, minSize);
      return defaultSize;
    };

    return [
      columnHelper.display({
        id: "select",
        size: getSize("select", 48, 36),
        minSize: 36,
        enableSorting: false,
        enableResizing: true,
      }),
      columnHelper.accessor("id", {
        size: getSize("id", 64, 48),
        minSize: 48,
        enableResizing: true,
      }),
      columnHelper.accessor("name", {
        size: getSize("name", 180, 80),
        minSize: 80,
        enableSorting: false,
        enableResizing: true,
      }),
      columnHelper.accessor("area", {
        size: getSize("area", 140, 60),
        minSize: 60,
        enableSorting: false,
        enableResizing: true,
      }),
      columnHelper.accessor("nodegroup", {
        size: getSize("nodegroup", 80, 64),
        minSize: 64,
        enableSorting: false,
        enableResizing: true,
      }),
      columnHelper.accessor("china", {
        size: getSize("china", 80, 64),
        minSize: 64,
        enableSorting: false,
        enableResizing: true,
      }),
      columnHelper.display({
        id: "status",
        size: getSize("status", 96, 80),
        minSize: 80,
        enableSorting: false,
        enableResizing: true,
      }),
      columnHelper.accessor("latency", {
        size: getSize("latency", 80, 64),
        minSize: 64,
        enableResizing: true,
        // 未测试节点的延迟视为 Infinity，排在最后（升序）或最前（降序）
        sortFn: (rowA, rowB) => {
          const a = getDisplayedLatency(rowA.original) ?? Infinity;
          const b = getDisplayedLatency(rowB.original) ?? Infinity;
          return a - b;
        },
      }),
      columnHelper.accessor("downloadSpeed", {
        size: getSize("downloadSpeed", 96, 80),
        minSize: 80,
        enableResizing: true,
        // 未测试节点的速度视为 -1，排在最前（升序）或最后（降序）
        sortFn: (rowA, rowB) => {
          const a = getDisplayedSpeed(rowA.original) ?? -1;
          const b = getDisplayedSpeed(rowB.original) ?? -1;
          return a - b;
        },
      }),
      columnHelper.display({
        id: "recommendScore",
        size: getSize("recommendScore", 88, 72),
        minSize: 72,
        enableResizing: true,
        // 推荐值基于速度和延迟加权计算，未测试节点视为 -1
        sortFn: (rowA, rowB) => {
          const a = calcRecommendScore(rowA.original) ?? -1;
          const b = calcRecommendScore(rowB.original) ?? -1;
          return a - b;
        },
      }),
    ] as ColumnDef<typeof features, NodeWithTest>[];
  }, [autoColumnWidths, getDisplayedLatency, getDisplayedSpeed]);

  // ===== 创建 TanStack Table 实例 =====
  const table = useTable({
    features,
    columns,
    data: filteredNodes,
    state: { sorting, columnSizing },
    onSortingChange: setSorting,
    onColumnSizingChange: setColumnSizing,
    enableColumnResizing: true,
    columnResizeMode: "onChange",
    getRowId: (row) => String(row.id),
  });

  // 计算当前可见节点中的选中数量
  const visibleSelectedCount = useMemo(() => {
    return filteredNodes.filter((n) => selectedNodeIds.has(n.id)).length;
  }, [filteredNodes, selectedNodeIds]);

  const toggleSelectAll = useCallback(() => {
    if (visibleSelectedCount === filteredNodes.length) {
      setSelectedNodeIds(new Set());
    } else {
      setSelectedNodeIds(new Set(filteredNodes.map((n) => n.id)));
    }
  }, [filteredNodes, visibleSelectedCount]);

  const handleRowClick = useCallback(
    (e: React.MouseEvent, nodeId: number, index: number) => {
      if (e.shiftKey && lastClickedIndex !== null) {
        const start = Math.min(lastClickedIndex, index);
        const end = Math.max(lastClickedIndex, index);
        const rangeIds = filteredNodes.slice(start, end + 1).map((n) => n.id);
        setSelectedNodeIds(new Set(rangeIds));
      } else {
        toggleSelectNode(nodeId);
      }
      setLastClickedIndex(index);
    },
    [filteredNodes, lastClickedIndex, toggleSelectNode],
  );

  /** 当前是否为本机→本机（默认设备对） */
  const isDefaultPair = pairKeyOf(currentPair) === pairKeyOf(DEFAULT_PAIR);

  const filteredHistory = useMemo(() => {
    // 只显示当前选中设备对（发送端→接收端）的测试历史；旧记录无 pairKey 时视为 本机→本机
    const currentPairKey = pairKeyOf(currentPair);
    return testHistory
      .filter((record) => {
        const matchesRegion =
          regionFilter === "all" ||
          (regionFilter === "domestic" && record.china === "yes") ||
          (regionFilter === "foreign" && record.china === "no");

        const matchesPair =
          (record.pairKey ?? "local__local") === currentPairKey;

        return matchesRegion && matchesPair;
      })
      .sort((a, b) => b.timestamp - a.timestamp);
  }, [testHistory, regionFilter, userTypeFilter, currentPair]);

  const openBatchSpeedTestWithNodes = useCallback(() => {
    const nodesToTest =
      visibleSelectedCount > 0
        ? filteredNodes.filter((n) => selectedNodeIds.has(n.id))
        : filteredNodes;

    if (nodesToTest.length === 0) {
      toast.error("没有可测试的节点");
      return;
    }

    setBatchTestNodes(nodesToTest);
    setShowBatchTestDialog(true);
  }, [filteredNodes, selectedNodeIds, visibleSelectedCount]);

  const getStatusBadge = (node: NodeWithTest) => {
    switch (node.testStatus) {
      case "testing":
        return (
          <Badge variant="outline" className="flex items-center gap-1">
            <RefreshCw className="w-3 h-3 animate-spin" />
            测试中
          </Badge>
        );
      case "success":
        return (
          <Badge className="bg-green-500/20 text-green-600 hover:bg-green-500/30 flex items-center gap-1">
            <CheckCircle2 className="w-3 h-3" />
            成功
          </Badge>
        );
      case "failed":
        return (
          <Badge variant="destructive" className="flex items-center gap-1">
            <XCircle className="w-3 h-3" />
            失败
          </Badge>
        );
      default:
        return (
          <Badge variant="outline" className="text-muted-foreground">
            未测试
          </Badge>
        );
    }
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleString("zh-CN");
  };

  // 登录状态：未登录时禁止测试/刷新/历史等操作（涉及账号隔离的缓存数据）
  const isLoggedIn = !!user?.username;

  // ===== 表头渲染辅助 =====
  const renderSortIcon = (columnId: string) => {
    const sortState = table.state.sorting.find((s) => s.id === columnId);
    if (!sortState) return <ArrowUpDown className="w-3 h-3 opacity-50" />;
    return sortState.desc ? (
      <ArrowDown className="w-3 h-3" />
    ) : (
      <ArrowUp className="w-3 h-3" />
    );
  };

  // 列宽拖拽手柄（拖拽调整列宽，双击恢复动态默认值）
  // 注意：getResizeHandler 是 Header 的方法，不是 Column 的
  const renderResizeHandle = (
    header: Header<typeof features, NodeWithTest>,
  ) => {
    const column = header.column;
    if (!column.getCanResize()) return null;
    return (
      <span
        onMouseDown={header.getResizeHandler()}
        onDoubleClick={() => column.resetSize()}
        className="absolute right-0 top-1/2 -translate-y-1/2 h-4 w-1 rounded-full cursor-col-resize bg-muted-foreground/12 hover:bg-primary/70 transition-colors"
        title="拖拽调整列宽，双击恢复默认"
      />
    );
  };

  return (
    <div className="flex flex-col h-full gap-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex shrink-0 items-center gap-3 whitespace-nowrap">
          <h1 className="text-xl font-medium text-foreground">节点测试</h1>
          {!loading && filteredNodes.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {filteredNodes.length} 个节点
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap gap-1 md:flex-1 md:flex-nowrap md:justify-end xl:gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              // 进入历史视图时重新读取，确保包含最近测试写入的记录
              if (!showHistory) loadHistory();
              setShowHistory(!showHistory);
            }}
            disabled={!isLoggedIn}
            className="h-8 px-2 text-xs xl:px-3"
            title={!isLoggedIn ? "请先登录" : undefined}
          >
            <History className="h-3.5 w-3.5 mr-1.5" />
            {showHistory ? "返回列表" : "测试历史"}
          </Button>
          <Button
            size="sm"
            onClick={() => void loadNodes()}
            disabled={loading || !isLoggedIn}
            className="h-8 px-2 text-xs xl:px-3"
            title={!isLoggedIn ? "请先登录" : undefined}
          >
            {loading ? (
              <>
                <RefreshCw className="animate-spin h-3.5 w-3.5 mr-1.5" />
                加载中...
              </>
            ) : (
              <>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                刷新列表
              </>
            )}
          </Button>
          {!showHistory && (
            <>
              {/* 当前设备对显示 + 切换按钮 */}
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowPairSelector(true)}
                disabled={!isLoggedIn || testingAll}
                className="h-8 min-w-0 shrink items-center px-2 text-xs xl:px-3"
                title={
                  !isLoggedIn
                    ? "请先登录"
                    : testingAll
                      ? "测试进行中"
                      : `${currentPair.senderName} → ${currentPair.receiverName}`
                }
              >
                {currentPair.senderId === "local" ? (
                  <Monitor className="h-3.5 w-3.5 shrink-0 mr-1.5 text-green-500" />
                ) : (
                  <Server className="h-3.5 w-3.5 shrink-0 mr-1.5 text-blue-500" />
                )}
                <span className="min-w-0 shrink truncate">
                  {currentPair.senderName}
                </span>
                <ArrowRightLeft className="h-3 w-3 shrink-0 mx-1 text-muted-foreground" />
                {currentPair.receiverId === "local" ? (
                  <Monitor className="h-3.5 w-3.5 shrink-0 mr-1.5 text-green-500" />
                ) : (
                  <Server className="h-3.5 w-3.5 shrink-0 mr-1.5 text-blue-500" />
                )}
                <span className="min-w-0 shrink truncate">
                  {currentPair.receiverName}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0 ml-1 text-muted-foreground" />
              </Button>
            </>
          )}
          {!showHistory &&
            (testingAll ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowBatchTestDialog(true)}
                  className="h-8 px-2 text-xs xl:px-3"
                >
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  测试中...
                </Button>
                {isBatchStopping ? (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={cancelStopTesting}
                      className="h-8 px-2 text-xs xl:px-3"
                    >
                      取消停止
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      onClick={forceStopTesting}
                      className="h-8 px-2 text-xs xl:px-3"
                    >
                      <SquareX className="h-3.5 w-3.5 mr-1.5" />
                      强制停止
                    </Button>
                  </>
                ) : (
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={stopTesting}
                    className="h-8 px-2 text-xs xl:px-3"
                  >
                    <SquareX className="h-3.5 w-3.5 mr-1.5" />
                    停止
                  </Button>
                )}
              </>
            ) : (
              <Button
                size="sm"
                onClick={openBatchSpeedTestWithNodes}
                disabled={
                  !isLoggedIn ||
                  loading ||
                  (visibleSelectedCount === 0 && filteredNodes.length === 0)
                }
                className="h-8 px-2 text-xs xl:px-3"
                title={!isLoggedIn ? "请先登录" : undefined}
              >
                <Zap className="h-3.5 w-3.5 mr-1.5" />
                {visibleSelectedCount > 0
                  ? `节点测试 (${visibleSelectedCount})`
                  : "全部测试"}
              </Button>
            ))}
        </div>
      </div>

      <div
        className={cn(
          "flex flex-wrap items-center gap-4 rounded-lg border bg-card px-3 py-2",
          effectType === "frosted" && "backdrop-blur-md",
          effectType === "translucent" && "bg-card/80",
        )}
      >
        <div className="flex items-center gap-2 flex-1 min-w-[200px]">
          <Search className="h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="搜索节点名称、区域、节点组..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="h-8 bg-transparent"
          />
          {searchQuery && (
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {filteredNodes.length} 结果
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">筛选：</span>
        </div>
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <Select
            options={regionOptions}
            value={regionFilter}
            onChange={(v) => setRegionFilter(v as RegionFilter)}
            placeholder="地域"
            size="sm"
            className="w-[120px]"
          />
        </div>
        <div className="flex items-center gap-2">
          <Users className="h-4 w-4 text-muted-foreground" />
          <Select
            options={userTypeOptions}
            value={userTypeFilter}
            onChange={(v) => setUserTypeFilter(v as UserTypeFilter)}
            placeholder="用户类型"
            size="sm"
            className="w-[120px]"
          />
        </div>
      </div>

      {!user ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Network className="size-6" />
            </EmptyMedia>
            <EmptyTitle>请先登录</EmptyTitle>
            <EmptyDescription>登录后才能查看和测试节点</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : loading ? (
        <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
          加载中...
        </div>
      ) : showHistory ? (
        <div
          key="history-view"
          className={cn(
            "flex-1 min-h-0 rounded-md border bg-card overflow-y-auto visible-scrollbar",
            effectType === "frosted" && "backdrop-blur-md bg-card/80",
            effectType === "translucent" && "bg-card/80",
          )}
        >
          {historyLoading ? (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              加载中...
            </div>
          ) : filteredHistory.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <History className="size-6" />
                </EmptyMedia>
                <EmptyTitle>暂无测试记录</EmptyTitle>
                <EmptyDescription>
                  {isDefaultPair
                    ? "还没有进行过节点测试"
                    : `当前设备对（${currentPair.senderName} → ${currentPair.receiverName}）还没有测试记录`}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table className="w-full">
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[48px] w-12">状态</TableHead>
                  <TableHead className="min-w-[80px] max-w-[180px]">
                    节点名称
                  </TableHead>
                  <TableHead className="min-w-[60px] max-w-[140px]">
                    区域
                  </TableHead>
                  <TableHead className="min-w-[60px]">延迟</TableHead>
                  <TableHead className="min-w-[120px]">时间</TableHead>
                  <TableHead className="min-w-[60px]">错误</TableHead>
                  <TableHead className="w-[60px]">详情</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredHistory.map((record) => (
                  <TableRow key={`${record.id}-${record.timestamp}`}>
                    <TableCell>
                      {record.success ? (
                        <CheckCircle2 className="w-4 h-4 text-green-500" />
                      ) : (
                        <XCircle className="w-4 h-4 text-red-500" />
                      )}
                    </TableCell>
                    <TableCell className="font-medium min-w-[80px] max-w-[180px]">
                      <span className="block truncate" title={record.nodeName}>
                        {record.nodeName}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground min-w-[60px] max-w-[140px]">
                      <span className="block truncate">{record.area}</span>
                    </TableCell>
                    <TableCell>
                      {record.latency != null ? (
                        <span
                          className={
                            record.latency < 100
                              ? "text-green-600"
                              : record.latency < 300
                                ? "text-yellow-600"
                                : "text-red-600"
                          }
                        >
                          {record.latency.toFixed(0)}ms
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs whitespace-nowrap">
                      {formatTime(record.timestamp)}
                    </TableCell>
                    <TableCell className="text-destructive text-xs max-w-[200px]">
                      {record.error ? (
                        <span className="block truncate" title={record.error}>
                          {record.error}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">-</span>
                      )}
                    </TableCell>
                    <TableCell>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 w-7 p-0"
                        onClick={() => setSelectedHistoryRecord(record as TestHistoryRecord)}
                        title="查看测试详情"
                      >
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>
      ) : filteredNodes.length === 0 ? (
        <Empty className="flex-1">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Network className="size-6" />
            </EmptyMedia>
            <EmptyTitle>暂无节点</EmptyTitle>
            <EmptyDescription>未找到可用的节点，请稍后再试</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void loadNodes()}
            >
              刷新
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div
          key="nodes-view"
          ref={tableContainerRef}
          className={cn(
            "thead-locked h-scroll-outer flex-1 min-h-0 rounded-md border bg-card overflow-auto visible-scrollbar",
            effectType === "frosted" && "backdrop-blur-md bg-card/80",
            effectType === "translucent" && "bg-card/80",
          )}
        >
          <Table
            className="w-full table-fixed"
            containerClassName="!overflow-visible"
          >
            <TableHeader className="[&>tr]:sticky [&>tr]:top-0 [&>tr]:right-0 [&>tr]:z-30">
              {table.getHeaderGroups().map((headerGroup) => (
                <TableRow key={headerGroup.id}>
                  {headerGroup.headers.map((header) => {
                    const columnId = header.column.id;
                    const width = header.getSize();
                    return (
                      <TableHead
                        key={header.id}
                        style={{ width, minWidth: width, maxWidth: width }}
                        className="relative"
                      >
                        {/* 根据列 ID 渲染不同的表头内容 */}
                        {columnId === "select" ? (
                          <button
                            onClick={toggleSelectAll}
                            className="flex items-center justify-center"
                          >
                            {selectedNodeIds.size === filteredNodes.length &&
                            filteredNodes.length > 0 ? (
                              <CheckSquare className="w-4 h-4" />
                            ) : (
                              <Square className="w-4 h-4" />
                            )}
                          </button>
                        ) : columnId === "recommendScore" ? (
                          <button
                            onClick={header.column.getToggleSortingHandler()}
                            className="flex items-center gap-1 hover:text-foreground transition-colors"
                            title="基于带宽速度（60%）和延迟（40%）加权计算"
                          >
                            推荐值
                            {renderSortIcon(columnId)}
                          </button>
                        ) : COLUMN_CONFIG.find((c) => c.id === columnId)
                            ?.enableSorting ? (
                          <button
                            onClick={header.column.getToggleSortingHandler()}
                            className="flex items-center gap-1 hover:text-foreground transition-colors"
                          >
                            {typeof header.column.columnDef.header === "string"
                              ? header.column.columnDef.header
                              : columnId === "id"
                                ? "编号"
                                : columnId === "name"
                                  ? "节点名称"
                                  : columnId === "area"
                                    ? "区域"
                                    : columnId === "nodegroup"
                                      ? "节点组"
                                      : columnId === "china"
                                        ? "地域"
                                        : columnId === "status"
                                          ? "状态"
                                          : columnId === "latency"
                                            ? "延迟"
                                            : columnId === "downloadSpeed"
                                              ? "带宽速度"
                                              : columnId}
                            {renderSortIcon(columnId)}
                          </button>
                        ) : (
                          <>
                            {columnId === "id"
                              ? "编号"
                              : columnId === "name"
                                ? "节点名称"
                                : columnId === "area"
                                  ? "区域"
                                  : columnId === "nodegroup"
                                    ? "节点组"
                                    : columnId === "china"
                                      ? "地域"
                                      : columnId === "status"
                                        ? "状态"
                                        : columnId === "latency"
                                          ? "延迟"
                                          : columnId === "downloadSpeed"
                                            ? "带宽速度"
                                            : columnId}
                          </>
                        )}
                        {renderResizeHandle(header)}
                      </TableHead>
                    );
                  })}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {table.getRowModel().rows.map((row, visualIndex) => {
                const node = row.original;
                return (
                  <TableRow
                    key={row.id}
                    className={cn(
                      selectedNodeIds.has(node.id) && "bg-accent/50",
                    )}
                  >
                    {row.getAllCells().map((cell) => {
                      const columnId = cell.column.id;
                      const width = cell.column.getSize();
                      return (
                        <TableCell
                          key={cell.id}
                          style={{ width, minWidth: width, maxWidth: width }}
                        >
                          {columnId === "select" ? (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                handleRowClick(e, node.id, visualIndex);
                              }}
                              className="flex items-center justify-center"
                            >
                              {selectedNodeIds.has(node.id) ? (
                                <CheckSquare className="w-4 h-4" />
                              ) : (
                                <Square className="w-4 h-4" />
                              )}
                            </button>
                          ) : columnId === "id" ? (
                            <span className="text-muted-foreground">
                              {node.id}
                            </span>
                          ) : columnId === "name" ? (
                            <span
                              className="font-medium block truncate"
                              title={node.name}
                            >
                              {highlightText(node.name, searchQuery)}
                            </span>
                          ) : columnId === "area" ? (
                            <span className="block truncate" title={node.area}>
                              {highlightText(node.area, searchQuery)}
                            </span>
                          ) : columnId === "nodegroup" ? (
                            <Badge
                              variant={
                                node.nodegroup === "vip" ? "default" : "outline"
                              }
                              className="text-xs"
                            >
                              {node.nodegroup === "vip" ? "VIP" : "普通"}
                            </Badge>
                          ) : columnId === "china" ? (
                            <Badge variant="outline" className="text-xs">
                              {node.china === "yes" ? "国内" : "国外"}
                            </Badge>
                          ) : columnId === "status" ? (
                            getStatusBadge(node)
                          ) : columnId === "latency" ? (
                            getDisplayedLatency(node) != null ? (
                              <span
                                className="flex items-center gap-1 cursor-pointer hover:text-primary transition-colors"
                                onClick={() =>
                                  setHistoryNode({ node, type: "latency" })
                                }
                                title="点击查看延迟历史"
                              >
                                <Clock className="w-3 h-3 text-muted-foreground" />
                                {getDisplayedLatency(node)!.toFixed(0)}ms
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )
                          ) : columnId === "downloadSpeed" ? (
                            getDisplayedSpeed(node) != null ? (
                              <span
                                className="flex items-center gap-1 cursor-pointer hover:text-primary transition-colors"
                                onClick={() =>
                                  setHistoryNode({ node, type: "speed" })
                                }
                                title="点击查看速度历史"
                              >
                                <Download className="w-3 h-3 text-muted-foreground" />
                                {getDisplayedSpeed(node)! >= 1000
                                  ? `${(getDisplayedSpeed(node)! / 1000).toFixed(1)} Gbps`
                                  : `${getDisplayedSpeed(node)!.toFixed(0)} Mbps`}
                              </span>
                            ) : (
                              <span className="text-muted-foreground">-</span>
                            )
                          ) : columnId === "recommendScore" ? (
                            (() => {
                              const score = calcRecommendScore(node);
                              if (score == null) {
                                return (
                                  <span className="text-muted-foreground">
                                    -
                                  </span>
                                );
                              }
                              const color =
                                score >= 80
                                  ? "text-green-600 dark:text-green-400"
                                  : score >= 60
                                    ? "text-blue-600 dark:text-blue-400"
                                    : score >= 40
                                      ? "text-yellow-600 dark:text-yellow-400"
                                      : "text-red-600 dark:text-red-400";
                              return (
                                <span
                                  className={cn(
                                    "font-medium tabular-nums",
                                    color,
                                  )}
                                  title="基于带宽速度（60%）和延迟（40%）加权计算"
                                >
                                  {score.toFixed(2)}
                                </span>
                              );
                            })()
                          ) : null}
                        </TableCell>
                      );
                    })}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <SpeedTestDialog
        isOpen={showBatchTestDialog && batchTestNodes !== null}
        onClose={(isMinimized?: boolean) => {
          setShowBatchTestDialog(false);
          if (!isMinimized) {
            setBatchTestNodes(null);
          }
        }}
        nodeNames={batchTestNodes?.map((n) => n.name) || []}
        pair={currentPair}
        onTestComplete={(results, pair, shouldShowLogs) => {
          const updatedNodes = [...nodesRef.current];
          results.forEach((result, nodeName) => {
            const details = result.details;
            const nodeIndex = updatedNodes.findIndex(
              (n) => n.name === nodeName,
            );
            if (nodeIndex !== -1) {
              const node = updatedNodes[nodeIndex];
              // 合并新旧测试结果：仅更新本次测试包含的字段，保留上次测试的另一项结果
              const mergedLatency = result.latency ?? node.latency;
              const mergedSpeed = result.downloadSpeed ?? node.downloadSpeed;
              const mergedLatencySamples = details?.latencySamples.length
                ? details.latencySamples
                : node.latencySamples;
              const mergedSpeedSamples = details?.speedSamples.length
                ? details.speedSamples
                : node.speedSamples;
              addTestHistory(
                {
                  nodeName: node.name,
                  nodeId: node.id,
                  timestamp: Date.now(),
                  latency: mergedLatency,
                  downloadSpeed: mergedSpeed,
                  success: result.success,
                  error: result.error ?? undefined,
                  latencySamples: mergedLatencySamples,
                  speedSamples: mergedSpeedSamples,
                  jitterMs: details?.jitterMs ?? undefined,
                  packetLossPercent: details?.packetLossPercent ?? undefined,
                  testDurationSeconds: details?.testDurationSeconds ?? undefined,
                  logs: result.logs,
                  senderId: pair.senderId,
                  senderName: pair.senderName,
                  receiverId: pair.receiverId,
                  receiverName: pair.receiverName,
                  pairKey: pairKeyOf(pair),
                },
                username,
              );
              updatedNodes[nodeIndex] = {
                ...node,
                testStatus: result.error
                  ? ("failed" as const)
                  : ("success" as const),
                latency: mergedLatency,
                downloadSpeed: mergedSpeed,
                error: result.error ?? undefined,
                lastTested: Date.now(),
                latencySamples: mergedLatencySamples,
                speedSamples: mergedSpeedSamples,
              };
            }
          });
          setNodes(updatedNodes);
          // 按测试时的设备对保存结果
          saveTestResultsForPair(pair, updatedNodes);
          // 自动切换到刚测试的设备对，让用户立即看到结果
          setCurrentPair(pair);
          saveDevicePair(localStorage, username, pair);
          loadHistory();
          // 节点测试完成埋点：仅在用户已登录时上报，失败静默不影响主流程
          if (user?.accessToken) {
            reportUsage({
              eventType: "node_test",
              eventData: { count: results.size },
            }).catch(() => {});
          }
          if (shouldShowLogs) {
            setShowBatchTestDialog(true);
          } else {
            setShowBatchTestDialog(false);
            setBatchTestNodes(null);
          }
        }}
      />

      <BatchTestFloatingWidget
        onExpand={() => setShowBatchTestDialog(true)}
        isDialogOpen={showBatchTestDialog && batchTestNodes !== null}
      />

      <NodeHistoryDialog
        isOpen={historyNode !== null}
        onClose={() => setHistoryNode(null)}
        nodeName={historyNode?.node.name || ""}
        type={historyNode?.type || "latency"}
        username={username}
        pair={currentPair}
      />
      <TestHistoryDetailDialog
        record={selectedHistoryRecord}
        onClose={() => setSelectedHistoryRecord(null)}
      />

      <PairSelectorDialog
        isOpen={showPairSelector}
        onClose={() => setShowPairSelector(false)}
        currentPair={currentPair}
        onSelect={(pair) => {
          setCurrentPair(pair);
          saveDevicePair(localStorage, username, pair);
          // 清除选中状态，避免切换设备对后选中错位
          setSelectedNodeIds(new Set());
        }}
        availablePairKeys={Object.keys(pairResults)}
      />
    </div>
  );
}
