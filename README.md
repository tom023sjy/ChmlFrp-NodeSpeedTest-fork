# ChmlFrp 社区工具箱

<div align="center">

**快速测试节点延迟，帮助用户选择最优节点**

[![GitHub release](https://img.shields.io/github/v/release/zhengddzz/ChmlFrp-Community-Toolbox?include_prereleases)](https://github.com/zhengddzz/ChmlFrp-Community-Toolbox/releases)
[![GitHub downloads](https://img.shields.io/github/downloads/zhengddzz/ChmlFrp-Community-Toolbox/total)](https://github.com/zhengddzz/ChmlFrp-Community-Toolbox/releases)
[![License](https://img.shields.io/github/license/zhengddzz/ChmlFrp-Community-Toolbox)](LICENSE)

[下载最新版本](https://github.com/zhengddzz/ChmlFrp-Community-Toolbox/releases/latest) | [问题反馈](https://github.com/zhengddzz/ChmlFrp-Community-Toolbox/issues)

</div>

---

## 核心功能

### 节点测试

- **节点自动探测** - 调用 API 扫描 ChmlFrp 可用节点列表，获取节点地区、运营商、在线状态等信息
- **多维度筛选** - 支持 VIP 节点、国内国外、UDP 支持等筛选条件，精准定位符合要求的节点
- **节点测速评估** - 默认执行 15 秒固定时长带宽测试，可配置 5～120 秒并自动记忆，下次启动继续使用
- **表格统计显示** - 延迟和带宽可分别显示采样最大值、平均值或最小值，延迟默认显示平均值，带宽默认显示最大值
- **测速结果弹窗** - 全部节点测速成功后自动关闭，存在失败或测试被停止时保留日志，最小化状态下失败会自动恢复弹窗
- **测试历史详情** - 按有向设备对保存成功和失败结果，支持查看单次测试指标、错误信息与完整日志
- **推荐值算法** - 综合速度得分（权重 60%）与延迟得分（权重 40%），自动计算推荐值并分级展示

### DNS 容灾

- **多平台支持** - 兼容 DNSPod.cn、DNSPod.com、阿里云、Cloudflare 域名 API
- **隧道状态监控** - 基于隧道状态与节点状态自动切换 DNS 记录
- **CNAME 自动填充** - 选中隧道后自动填充目标为隧道节点域名
- **可配置策略** - 自定义轮询间隔、失败切换阈值、恢复回切阈值

### 域名解析（DDNS）

- **多凭证来源** - 支持 ChmlFrp 免费域名或 DNS 凭证
- **自动监控** - 监控本机网卡 IP 变化并自动更新解析
- **灵活调度** - 支持固定时间点触发和分时段不同频率两种模式
- **记录类型** - A / AAAA / CNAME（CNAME 支持从隧道选择）

### SSL 证书管理

- **一键申请** - 自动完成申请、添加 TXT、等待 DNS、触发验证、轮询状态全流程
- **实时进度** - 浮动卡片展示申请阶段与日志流
- **后台异步** - 不阻塞 UI，支持多任务并行

### 设备互联

- **同账号自动发现** - 无需绑定码，同账号设备自动互相发现
- **设备名称持久化** - 设备重命名保存到账号设备记录，重新连接不会恢复默认名称；重装时需保留应用数据中的设备 ID 才能继续关联原设备
- **端到端延迟测试** - ICMP Ping + TCP Ping
- **端到端带宽测试** - 通过 FRP 有向链路执行固定时长 TCP 测速，实时推送窗口速度
- **Daemon 服务器支持** - 部署 [Daemon](https://github.com/zhengddzz/chmlfrp-toolbox-daemon) 后可远程管理 Linux 服务器

### 其他特性

- 窗口置顶，方便随时查看测试进度
- 测试结果按有向设备对持久化，详情展示单次延迟柱状图与逐秒速度折线图
- 节点测试顶栏在空间不足时优先压缩按钮间距与设备名称，仅在窄屏下换行
- 公告支持安全渲染 Markdown 标题、列表、引用、代码和网页链接，代码块支持复制与长行自动换行，弹窗随窗口宽高自适应，旧格式公告继续按纯文本显示
- 「关于」页应用公告列表仅显示标题，点击标题弹窗查看公告详情
- 自动检查更新（GitHub Releases）
- 数据加密存储（Windows DPAPI / Linux AES-256-GCM）

## 下载安装

### Windows
- 下载 `.msi` 或 `.exe` 安装包，双击安装

### macOS
- 下载 `.dmg` 文件，拖拽到应用程序文件夹

### Linux
- 下载 `.deb` 或 `.AppImage`，根据发行版安装
- 支持 x64 和 ARM64 架构

## 技术栈

- **前端**: React + TypeScript + Tailwind CSS + TanStack Table
- **后端**: Rust + Tauri
- **构建**: GitHub Actions

## 开发

```bash
# 安装依赖
pnpm install

# 开发模式
pnpm tauri dev

# 构建
pnpm tauri build
```

## 分支管理

| 分支 | 说明 |
|------|------|
| `main` | 生产分支，稳定版本代码 |
| `develop` | 开发分支，日常开发在此进行 |

### 提交规范

请遵循 [Conventional Commits](https://www.conventionalcommits.org/) 规范：

- `feat:` 新功能
- `fix:` 修复 Bug
- `docs:` 文档更新
- `style:` 代码格式调整
- `refactor:` 代码重构
- `chore:` 构建/工具变更

### 合并到生产分支

当 `develop` 分支开发完成并测试通过后，合并到 `main` 分支：

```bash
git checkout main
git merge develop
git push origin main
```

合并后会自动触发 GitHub Actions 构建并发布新版本。

## 相关项目

- [chmlfrp-toolbox-daemon](https://github.com/zhengddzz/chmlfrp-toolbox-daemon) - 服务器端远程管理守护进程

## 开源声明

本工具为社区开源项目，与 ChmlFrp 官方无隶属关系。
UI 设计基于 [ChmlFrpLauncher](https://github.com/TechCat-Team/ChmlFrpLauncher)，功能由 [zhengddzz](https://github.com/zhengddzz) 开发。

## 许可证

[MIT License](LICENSE)

## 致谢

- [Tauri](https://tauri.app/) - 跨平台桌面应用框架
- [ChmlFrp](https://www.chmlfrp.net/) - 免费内网穿透服务
