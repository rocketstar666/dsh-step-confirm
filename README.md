# dsh-step-confirm

DSH 的第四个权限挡位：**逐步确认**。

## 它做什么

只有“读工作区（会话当前目录）”是免费的；其余动作都会在你点一下之后才执行：

- 写任何文件（包括工作区内）
- 读工作区外的路径
- 执行任何命令（包括 `git status` 这种只读命令）
- 联网获取 / 搜索
- 切换工作目录

不记忆批准，也不记忆拒绝。无附言的拒绝会终止本轮（由 `dsh-approval-comment` 提供）；带附言的拒绝会让模型按附言调整后继续。

## 与现有三档的关系

不改动 `read-only` / `workspace-write` / `danger-full-access` 的任何行为。严格度排序：

```
逐步确认 > 仅可查看 > 可编辑 > 完全访问
```

它是“零自主权”，不是“更小的权限”——能写，但每次写都要你点。

## 安装

1. 安装插件包：

   ```
   dsh plugin --profile desktop add <本目录或 .tgz 路径>
   ```

2. 在 profile 的 `cordis.patch.yml` 里注册挡位（`permission` 那条之下）：

   ```yaml
   - id: permission
     name: "@deepseek-ai/dsh-permission-presets"
     config:
       presets:
         step-confirm:
           sandbox: workspace-write
           approval: ask
           name: "逐步确认"
           description: "只有读工作区免费，其余动作逐次确认"
   ```

3. 重启 DSH。

## 已知边界

- `step-confirm` 与“可编辑”档的旋钮值完全相同（`workspace-write` + `ask`），系统靠“最后一次选择”区分两者。若会话恢复后该选择丢失，会退化回“可编辑”，门禁**静默失效**。重启后请确认挡位仍是「逐步确认」。
- 模型一回合内并发发起多个调用时，审批卡会串行弹出。
- 路径只做基础规范化（`..`、符号链接、junction），不做对抗性路径安全。

## 卸载

```
dsh plugin --profile desktop remove dsh-step-confirm
```

同时删掉 profile `cordis.patch.yml` 里那条 `step-confirm`。
