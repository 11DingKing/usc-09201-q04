# 林权融资占用监测

面向集体林权改革与林下产业协作场景的融资占用服务：登记权证范围与估值版本、记录多家金融机构的授信冻结、
分期提款、偿还、撤销与部分地块释放，并实时给出可用余量。全部状态只增不改地落在带哈希链的事件日志上，
监管可随时重放重算，冲突响应与审计结论可复现。

零依赖，Node.js ≥ 20（仅用内置 `http` / `node:test`）。

- `npm start` 启动服务（默认 3000 端口，`PORT` 可覆盖），`GET /health` 健康检查。
- `npm test` 运行领域规则与 HTTP 端到端测试。

## 角色令牌（联调用，生产应替换为签名验签）

| Bearer 令牌 | 角色 | 说明 |
| --- | --- | --- |
| `token-registrar` | 登记机构 | 登记权证、发布估值、回执 |
| `token-regulator` | 监管协作方 | 全量视图、事件日志、重算审计 |
| `token-bank-a` | 金融机构 BANK_A | 仅可见自身授信 |
| `token-bank-b` | 金融机构 BANK_B | 仅可见自身授信 |

## 接口

写命令建议带 `Idempotency-Key` 头，重试不产生第二笔占用。机构路径只允许持有方操作。

| 方法与路径 | 角色 | 说明 |
| --- | --- | --- |
| `POST /certificates` | registrar | 登记权证、地块权重、初始估值 |
| `GET  /certificates/:id` | 全部 | 按权限裁剪的权证与实时余量 |
| `POST /certificates/:id/valuations` | registrar | 新增估值版本（不覆盖旧版本） |
| `POST /certificates/:id/facilities` | institution | 就地块冻结授信（并发冲突 409 留痕） |
| `GET  /facilities` / `GET /facilities/:id` | institution/regulator | 授信明细 |
| `POST /facilities/:id/drawdowns` | 持有机构 | 分期提款（额度 + 当前估值覆盖双重校验） |
| `POST /facilities/:id/repayments` | 持有机构 | 还款/提前还款，FIFO 冲抵 |
| `POST /facilities/:id/revocations` | 持有机构 | 申请撤销（期间新提款被拒） |
| `POST /facilities/:id/revocations/cancel` | 持有机构 | 撤回撤销 |
| `POST /facilities/:id/revocations/finalize` | 持有机构 | 结清后最终解除 |
| `POST /facilities/:id/releases` | 持有机构 | 申请部分地块释放 |
| `POST /releases/:id/receipts` | registrar/相关机构 | 回执（可乱序，集齐才决策） |
| `GET  /releases/:id` | 相关方/监管 | 释放状态与回执集合 |
| `GET  /regulator/events` | regulator | 全量事件与哈希链 |
| `POST /regulator/recompute` | regulator | 重放日志，逐权证比对余量与状态快照 |

## 关键约定

- 同一权证的命令经串行队列确定次序；同一地块先提交的冻结胜出，后者冲突留痕。
- 估值下调不抹除存量（以 `coverageShortfall` 暴露缺口），但挡住超额新提款；
  等待回执期间发生估值更正，释放决策按最新版本复核。
- 还款分配、回执次序、撤销拦截都固化为事件；监管重算结果与活动投影必须逐字段一致。

领域规则详见 [`docs/domain.md`](docs/domain.md)。
